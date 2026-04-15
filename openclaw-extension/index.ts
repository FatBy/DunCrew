/**
 * DunCrew OpenClaw Extension — Main entry point.
 *
 * Registers hooks:
 *   - before_prompt_build: Inject System Brief, Dun profile, SOP, Gene Pool hints
 *   - after_tool_call:     Track SOP progress, update recent entities, Gene Pool match + trace
 *   - llm_output:          Detect SOP adoption, parse ACTIVATE_DUN & SOP_REWRITE tags
 *   - session_start:       Initialize SOP tracker, reset Gene Pool session
 *   - agent_end:           Record experience, harvest genes, broadcast XP update
 *
 * All Dun data is persisted in {dataDir}/duns/{dunId}/ as plain files.
 * Gene Pool data is persisted in {dataDir}/genes/ as JSON files.
 */

import { join, dirname } from "path";
import { DunManager, type SOPMode } from "./src/dun-manager.js";
import { DDOS_SYSTEM_BRIEF } from "./src/system-brief.js";
import { ExtensionGenePool } from "./src/gene-pool.js";

// ============================================
// Plugin state (initialized in register())
// ============================================

let dunManager: DunManager;
let genePool: ExtensionGenePool;
let activeDunId: string | null = null;
let sessionTaskMessage = "";
let sessionToolsUsed: string[] = [];
let sessionStartTime = 0;
let sopMode: SOPMode = "skip";
let sopActive = false;
let sopFirstReply = true;
let promptBuildCount = 0;
let lastSOPReminderAt = 0;
const SOP_REMINDER_INTERVAL = 3;
let lastToolResult = "";

// T1: System Brief injection tracking
let systemBriefInjected = false;

// T5: Broadcast function cached from Gateway method handlers
let broadcastFn: ((event: string, payload: unknown) => void) | null = null;

// ============================================
// Config defaults
// ============================================

interface DdosPluginConfig {
  dunDataDir?: string;
  enableSOPInjection?: boolean;
  enableSOPEvolution?: boolean;
  enableDunCatalog?: boolean;
  enableAnaphoraResolution?: boolean;
  enableExperienceRecording?: boolean;
  enableGenePool?: boolean;
  maxSOPContentLength?: number;
  recentEntityExpireMs?: number;
}

const DEFAULT_CONFIG: Required<DdosPluginConfig> = {
  dunDataDir: "",
  enableSOPInjection: true,
  enableSOPEvolution: true,
  enableDunCatalog: true,
  enableAnaphoraResolution: true,
  enableExperienceRecording: true,
  enableGenePool: true,
  maxSOPContentLength: 16000,
  recentEntityExpireMs: 300000,
};

function resolveConfig(raw?: Record<string, unknown>): Required<DdosPluginConfig> {
  return { ...DEFAULT_CONFIG, ...(raw || {}) } as Required<DdosPluginConfig>;
}

// ============================================
// Helper: select active Dun by trigger matching
// ============================================

function matchDunByTrigger(
  query: string,
  manager: DunManager
): string | null {
  const queryLower = query.toLowerCase();
  const dunIds = manager.listDuns();

  for (const nid of dunIds) {
    const meta = manager.loadDunMeta(nid);
    if (!meta?.triggers) continue;
    for (const trigger of meta.triggers) {
      if (queryLower.includes(trigger.toLowerCase())) {
        return nid;
      }
    }
  }
  return null;
}

// ============================================
// Helper: cache broadcast from Gateway handler context
// ============================================

function captureBroadcast(context: any): void {
  if (context?.broadcast && typeof context.broadcast === "function") {
    broadcastFn = context.broadcast;
  }
}

// ============================================
// Plugin Definition
// ============================================

const plugin = {
  id: "ddos",
  name: "DunCrew Integration",
  description:
    "Dun-driven SOP execution, experience tracking, Gene Pool self-healing, and adaptive context injection for OpenClaw agents.",

  register(api: any) {
    const cfg = resolveConfig(api.pluginConfig);
    const dataDir = cfg.dunDataDir || join(dirname(api.source), "data");
    dunManager = new DunManager(dataDir);
    genePool = new ExtensionGenePool(dataDir);

    api.logger.info(`[DunCrew] Dun data dir: ${dataDir}`);
    api.logger.info(
      `[DunCrew] Config: SOP=${cfg.enableSOPInjection}, Anaphora=${cfg.enableAnaphoraResolution}, Experience=${cfg.enableExperienceRecording}, GenePool=${cfg.enableGenePool}`
    );
    api.logger.info(
      `[DunCrew] Loaded ${dunManager.listDuns().length} duns, ${genePool.getGeneCount()} genes`
    );

    // ========================================
    // Hook: before_prompt_build
    // T1: System Brief (cacheable, first time only)
    // T2: Dun Profile (dynamic, every turn)
    // T3: Gene Pool hints (dynamic, after errors)
    // Existing: SOP context + anaphora hints + rules
    // ========================================
    api.on("before_prompt_build", async (event: any) => {
      const dynamicParts: string[] = [];
      promptBuildCount++;

      // ── T1: System Brief (first prompt only) ──
      // prependSystemContext is cacheable and injected into system prompt.
      let systemBriefText: string | undefined;
      if (!systemBriefInjected) {
        systemBriefText = DDOS_SYSTEM_BRIEF;
        systemBriefInjected = true;
        api.logger.info("[DunCrew] System Brief injected via prependSystemContext");
      }

      // ── Auto-detect active Dun from user message ──
      const userMessage = event?.userMessage || event?.message || "";
      if (!activeDunId && userMessage) {
        activeDunId = matchDunByTrigger(userMessage, dunManager);
        if (activeDunId) {
          api.logger.info(`[DunCrew] Dun matched by trigger: ${activeDunId}`);
        }
      }

      // ── T2: Dun Profile (every turn when active) ──
      if (activeDunId) {
        const profile = dunManager.buildDunProfile(activeDunId);
        if (profile) {
          dynamicParts.push(profile);
        }
      }

      // ── Existing: SOP context ──
      if (activeDunId && cfg.enableSOPInjection) {
        if (promptBuildCount === 1) {
          const sopCtx = dunManager.buildSOPContext(
            activeDunId,
            cfg.maxSOPContentLength
          );
          if (sopCtx) {
            dynamicParts.push(sopCtx);
          }

          const evaluation = dunManager.evaluateSOPApplicability(
            userMessage || sessionTaskMessage,
            activeDunId
          );
          sopMode = evaluation.mode;
          sopActive = sopMode === "strict";
          sopFirstReply = sopMode === "optional";
          api.logger.info(
            `[DunCrew] SOP evaluation: mode=${sopMode}, reason="${evaluation.reason}"`
          );

          const directive = dunManager.buildSOPDirective(activeDunId, sopMode);
          if (directive) {
            dynamicParts.push("\n" + directive);
          }
        } else if (sopActive) {
          if (promptBuildCount - lastSOPReminderAt >= SOP_REMINDER_INTERVAL) {
            const reminder = dunManager.buildSOPReminder(
              activeDunId,
              sessionToolsUsed,
              lastToolResult
            );
            if (reminder) {
              dynamicParts.push("\n" + reminder);
              lastSOPReminderAt = promptBuildCount;
              api.logger.info(
                `[DunCrew] SOP reminder injected at prompt build #${promptBuildCount}`
              );
            }
          }
        }

        if (userMessage) {
          const experiences = dunManager.searchExperiences(
            activeDunId,
            userMessage,
            3
          );
          if (experiences.length > 0) {
            dynamicParts.push(
              "\n--- Relevant Experience ---\n" + experiences.join("\n\n")
            );
          }
        }

        const rulesCtx = dunManager.buildRulesContext(activeDunId);
        if (rulesCtx) {
          dynamicParts.push("\n" + rulesCtx);
        }

        // ── SOP Evolution: improvement hints + rewrite request ──
        if (cfg.enableSOPEvolution && promptBuildCount === 1) {
          const sopHints = dunManager.buildSOPImprovementHints(activeDunId);
          if (sopHints) {
            dynamicParts.push("\n" + sopHints);
            api.logger.info("[DunCrew] SOP improvement hints injected");
          }

          const rewriteReq = dunManager.buildSOPRewriteRequest(activeDunId);
          if (rewriteReq) {
            dynamicParts.push("\n" + rewriteReq);
            api.logger.info("[DunCrew] SOP rewrite request injected");
          }

          // ── Golden Path hint injection ──
          const goldenPathHint = dunManager.buildGoldenPathHint(activeDunId);
          if (goldenPathHint) {
            dynamicParts.push("\n" + goldenPathHint);
            api.logger.info("[DunCrew] Golden Path hint injected");
          }
        }
      }

      // ── Dun Catalog (when no active Dun) ──
      if (!activeDunId && cfg.enableDunCatalog && promptBuildCount <= 2) {
        const catalog = dunManager.buildDunCatalog();
        if (catalog) {
          dynamicParts.push("\n" + catalog);
          api.logger.info("[DunCrew] Dun catalog injected (no active Dun)");
        }
      }

      // ── Existing: Anaphora resolution ──
      if (cfg.enableAnaphoraResolution) {
        const anaphoraHint = dunManager.buildAnaphoraHint(
          cfg.recentEntityExpireMs
        );
        if (anaphoraHint) {
          dynamicParts.push("\n" + anaphoraHint);
        }
      }

      // ── T3: Gene Pool hints (after tool errors) ──
      if (cfg.enableGenePool) {
        const geneHints = genePool.consumePendingHints();
        if (geneHints) {
          dynamicParts.push("\n" + geneHints);
          api.logger.info("[DunCrew] Gene Pool hints injected into context");
        }

        // ── Pre-check hints: inject on first prompt when Dun is active ──
        if (promptBuildCount === 1 && activeDunId) {
          const preCheckHints = genePool.buildPreCheckHints(activeDunId);
          if (preCheckHints) {
            dynamicParts.push("\n" + preCheckHints);
            api.logger.info("[DunCrew] Pre-check hints injected from Gene Pool");
          }
        }
      }

      // ── Build return value ──
      const result: Record<string, string> = {};
      if (systemBriefText) {
        result.prependSystemContext = systemBriefText;
      }
      if (dynamicParts.length > 0) {
        result.prependContext = dynamicParts.join("\n\n");
      }
      if (Object.keys(result).length === 0) return;
      return result;
    });

    // ========================================
    // Hook: after_tool_call
    // Existing: SOP progress + entity tracking
    // T3: Gene Pool error matching
    // T4: Session trace recording
    // ========================================
    api.on("after_tool_call", async (event: any) => {
      // ── DEBUG: dump event structure to verify field names ──
      const eventKeys = event ? Object.keys(event) : [];
      api.logger.info(
        `[DunCrew][DEBUG] after_tool_call event keys: [${eventKeys.join(", ")}]`
      );
      api.logger.info(
        `[DunCrew][DEBUG] after_tool_call event dump: ${JSON.stringify(event, null, 0)?.slice(0, 1500)}`
      );

      const toolName = event?.toolName || event?.name || "";
      const toolArgs = event?.params || event?.args || event?.arguments || {};
      const toolResult =
        typeof event?.result === "string"
          ? event.result
          : JSON.stringify(event?.result || "").slice(0, 1000);
      const toolError = event?.error || "";

      api.logger.info(
        `[DunCrew][DEBUG] after_tool_call resolved: tool="${toolName}", hasError=${!!toolError}, errorSnippet="${toolError.slice(0, 200)}", resultSnippet="${toolResult.slice(0, 200)}"`
      );

      // Record last tool result (for SOP reminders)
      lastToolResult = toolResult;

      // Track tool usage for experience recording
      if (toolName && !sessionToolsUsed.includes(toolName)) {
        sessionToolsUsed.push(toolName);
      }

      // Existing: Update recent entities for anaphora resolution
      if (cfg.enableAnaphoraResolution) {
        dunManager.updateRecentEntities(toolName, toolArgs, toolResult);
      }

      // Existing: Infer SOP progress
      if (activeDunId && cfg.enableSOPInjection) {
        dunManager.inferSOPProgress(activeDunId, toolName, toolResult);
      }

      // ── T4: Record tool call in session trace ──
      if (cfg.enableGenePool) {
        genePool.recordToolCall({
          toolName,
          params: toolArgs,
          result: toolError || toolResult,
          error: toolError || undefined,
          durationMs: event?.durationMs,
        });
      }

      // ── T3: Gene Pool error matching ──
      if (cfg.enableGenePool && toolError) {
        genePool.matchAndQueue(toolName, toolError);
        api.logger.info(
          `[DunCrew] Gene Pool: error detected for ${toolName}, queued matching hints`
        );
      }
    });

    // ========================================
    // Hook: llm_output (replaces after_model_response)
    // Detect SOP adoption for optional mode
    // ========================================
    api.on("llm_output", async (event: any) => {
      // llm_output provides assistantTexts: string[]
      const assistantTexts: string[] = event?.assistantTexts || [];
      const responseText = assistantTexts.join("\n");
      if (!responseText) return;

      // ── Existing: SOP adoption detection ──
      if (activeDunId && sopFirstReply && sopMode === "optional") {
        sopFirstReply = false;
        const adopted = dunManager.detectSOPAdoption(responseText);
        sopActive = adopted;
        api.logger.info(
          `[DunCrew] SOP adoption detection: ${adopted ? "FOLLOW" : "FREE"}`
        );
      }

      // ── Dun Catalog: parse <ACTIVATE_DUN> ──
      if (!activeDunId && cfg.enableDunCatalog) {
        const dunMatch = responseText.match(
          /<ACTIVATE_DUN>(\S+)<\/ACTIVATE_DUN>/
        );
        if (dunMatch) {
          const candidateId = dunMatch[1];
          const meta = dunManager.loadDunMeta(candidateId);
          if (meta) {
            activeDunId = candidateId;
            if (meta.sopContent) {
              dunManager.createSOPTracker(
                candidateId,
                meta.name,
                meta.sopContent
              );
              const evaluation = dunManager.evaluateSOPApplicability(
                sessionTaskMessage,
                candidateId
              );
              sopMode = evaluation.mode;
              sopActive = sopMode === "strict";
              sopFirstReply = sopMode === "optional";
            }
            api.logger.info(
              `[DunCrew] Agent activated Dun: ${candidateId} (${meta.name})`
            );
            if (broadcastFn) {
              try {
                const xpData = dunManager.loadDunXP(candidateId);
                broadcastFn("ddos.dun.activated", {
                  dunId: candidateId,
                  dunName: meta.name,
                  xp: xpData.xp,
                  level: xpData.level,
                  activatedBy: "agent",
                });
              } catch (err) {
                api.logger.warn(
                  `[DunCrew] Failed to broadcast Dun activation: ${err}`
                );
              }
            }
          } else {
            api.logger.warn(
              `[DunCrew] Agent tried to activate unknown Dun: ${candidateId}`
            );
          }
        }
      }

      // ── SOP Evolution: parse <SOP_REWRITE> ──
      if (activeDunId && cfg.enableSOPEvolution) {
        const sopMatch = responseText.match(
          /<SOP_REWRITE>([\s\S]*?)<\/SOP_REWRITE>/
        );
        if (sopMatch) {
          const newSOP = sopMatch[1].trim();
          if (newSOP.length > 50) {
            const written = dunManager.writeSOPContent(
              activeDunId,
              newSOP
            );
            if (written) {
              dunManager.resetSOPFitnessAfterRewrite(activeDunId);
              api.logger.info(
                `[DunCrew] SOP rewritten by Agent for Dun: ${activeDunId}`
              );
              if (broadcastFn) {
                try {
                  broadcastFn("ddos.dun.sopUpdated", {
                    dunId: activeDunId,
                    updatedBy: "agent",
                  });
                } catch (err) {
                  api.logger.warn(
                    `[DunCrew] Failed to broadcast SOP update: ${err}`
                  );
                }
              }
            }
          }
        }
      }

      // ── Skill Binding: parse <BIND_SKILL> ──
      if (activeDunId) {
        const bindMatches = responseText.matchAll(
          /<BIND_SKILL>([^<]+)<\/BIND_SKILL>/g
        );
        for (const match of bindMatches) {
          const skillName = match[1].trim();
          if (skillName) {
            api.logger.info(
              `[DunCrew] Agent binding skill "${skillName}" to Dun ${activeDunId}`
            );
            if (broadcastFn) {
              try {
                broadcastFn("ddos.dun.skillBound", {
                  dunId: activeDunId,
                  skillName,
                  boundBy: "agent",
                });
              } catch (err) {
                api.logger.warn(
                  `[DunCrew] Failed to broadcast skill binding: ${err}`
                );
              }
            }
          }
        }
      }
    });

    // ========================================
    // Hook: session_start
    // Initialize SOP tracker, reset Gene Pool session
    // ========================================
    api.on("session_start", async (event: any) => {
      // Reset session state
      sessionTaskMessage = event?.message || "";
      sessionToolsUsed = [];
      sessionStartTime = Date.now();
      activeDunId = null;
      sopMode = "skip";
      sopActive = false;
      sopFirstReply = true;
      promptBuildCount = 0;
      lastSOPReminderAt = 0;
      lastToolResult = "";

      // T1: Reset System Brief flag for new session
      systemBriefInjected = false;

      // T4: Reset Gene Pool session trace
      if (cfg.enableGenePool) {
        genePool.resetSession();
      }

      // Auto-match Dun from initial message
      if (sessionTaskMessage) {
        activeDunId = matchDunByTrigger(sessionTaskMessage, dunManager);
      }

      // Initialize SOP tracker
      if (activeDunId) {
        const meta = dunManager.loadDunMeta(activeDunId);
        if (meta?.sopContent) {
          dunManager.createSOPTracker(
            activeDunId,
            meta.name,
            meta.sopContent
          );
          api.logger.info(
            `[DunCrew] SOP tracker initialized for Dun: ${meta.name}`
          );
        }
      }
    });

    // ========================================
    // Hook: agent_end
    // Existing: Record experience
    // T4: Harvest genes from session trace
    // T5: Calculate and broadcast XP update
    // ========================================
    api.on("agent_end", async (event: any) => {
      // ── DEBUG: dump agent_end event ──
      const eventKeys = event ? Object.keys(event) : [];
      api.logger.info(
        `[DunCrew][DEBUG] agent_end event keys: [${eventKeys.join(", ")}]`
      );
      api.logger.info(
        `[DunCrew][DEBUG] agent_end: activeDunId=${activeDunId}, enableGenePool=${cfg.enableGenePool}, traceLength=${genePool.getSessionTrace().length}`
      );

      const duration = event?.durationMs || (Date.now() - sessionStartTime);
      const isSuccess = event?.success === true;
      const isError = !isSuccess;

      api.logger.info(
        `[DunCrew][DEBUG] agent_end: success=${event?.success}, isSuccess=${isSuccess}, isError=${isError}`
      );

      // ── Existing: Record experience ──
      if (activeDunId && cfg.enableExperienceRecording && sessionTaskMessage) {
        dunManager.recordExperience(
          activeDunId,
          isError ? "failure" : "success",
          {
            task: sessionTaskMessage,
            toolsUsed: sessionToolsUsed,
            duration,
            output: isSuccess
              ? String(event?.result || "").slice(0, 500)
              : undefined,
            error: isError
              ? String(event?.error || "unknown")
              : undefined,
          }
        );
        api.logger.info(
          `[DunCrew] Experience recorded for ${activeDunId}: ${isError ? "failure" : "success"} (${Math.round(duration / 1000)}s)`
        );
      }

      // ── T4: Gene Pool harvesting ──
      if (cfg.enableGenePool) {
        const traceSnapshot = genePool.getSessionTrace();
        api.logger.info(
          `[DunCrew][DEBUG] Gene Pool harvest check: traceLength=${traceSnapshot.length}, activeDun=${activeDunId}`
        );
        if (traceSnapshot.length > 0) {
          api.logger.info(
            `[DunCrew][DEBUG] Session trace statuses: [${traceSnapshot.map(t => `${t.name}:${t.status}`).join(", ")}]`
          );
        }
        const harvested = genePool.harvestGenes(activeDunId || undefined);
        if (harvested.length > 0) {
          api.logger.info(
            `[DunCrew] Gene Pool: harvested ${harvested.length} new gene(s) for ${activeDunId || "global"}`
          );
        } else {
          api.logger.info(
            `[DunCrew][DEBUG] Gene Pool: no genes harvested (no error->success pairs found)`
          );
        }
      }

      // ── T5: XP calculation and broadcast ──
      if (activeDunId) {
        let xpDelta = 0;
        if (isSuccess) {
          xpDelta = 10; // Base success XP
          if (sessionToolsUsed.length > 3) xpDelta += 5; // Complex task bonus
          if (sopActive) xpDelta += 5; // SOP adherence bonus
        } else {
          xpDelta = -2; // Failure penalty
        }

        const currentXP = dunManager.loadDunXP(activeDunId);
        const newXP = Math.max(0, currentXP.xp + xpDelta);
        dunManager.saveDunXP(activeDunId, newXP);
        const newLevel = DunManager.xpToLevel(newXP);

        api.logger.info(
          `[DunCrew] XP update: ${activeDunId} ${xpDelta > 0 ? "+" : ""}${xpDelta} → XP ${newXP} (Lv${newLevel})`
        );

        // Broadcast to DunCrew frontend
        if (broadcastFn) {
          try {
            broadcastFn("ddos.dun.xpUpdate", {
              dunId: activeDunId,
              xpDelta,
              newXP,
              newLevel,
              reason: isSuccess ? "task_success" : "task_failure",
            });
            api.logger.info("[DunCrew] XP update broadcasted to frontend");
          } catch (err) {
            api.logger.warn(`[DunCrew] Failed to broadcast XP update: ${err}`);
          }
        } else {
          api.logger.info("[DunCrew] XP saved locally (broadcast not available)");
        }
      }

      // ── SOP Evolution: compute and persist fitness ──
      if (activeDunId && cfg.enableSOPEvolution) {
        try {
          const sessionTrace = genePool.getSessionTrace();
          const sopTracker = dunManager.getSOPTracker(activeDunId);
          const { fitness, traceSummary } =
            dunManager.computeSessionFitness(sessionTrace, sopTracker ?? null, isSuccess);
          const updatedFitness =
            dunManager.updateSOPFitness(activeDunId, traceSummary);
          api.logger.info(
            `[DunCrew] SOP fitness: ${(fitness * 100).toFixed(0)}%, ema: ${(updatedFitness.ema * 100).toFixed(0)}% (${updatedFitness.totalExecutions} executions)`
          );
        } catch (err) {
          api.logger.warn(`[DunCrew] SOP fitness update failed: ${err}`);
        }
      }

      // ── Golden Path: distill after sufficient successes ──
      if (activeDunId && isSuccess && cfg.enableSOPEvolution) {
        try {
          const existing = dunManager.loadGoldenPath(activeDunId);
          const DISTILL_COOLDOWN_MS = 600_000; // 10 minutes minimum between distillations
          const shouldDistill = !existing
            || (Date.now() - existing.lastDistilledAt > DISTILL_COOLDOWN_MS);

          if (shouldDistill) {
            const goldenPath = dunManager.distillGoldenPath(activeDunId);
            if (goldenPath) {
              api.logger.info(
                `[DunCrew] Golden Path distilled for ${activeDunId}: ${goldenPath.recommendedToolChain.join(" -> ")} (confidence: ${Math.round(goldenPath.confidence * 100)}%)`
              );
            }
          }
        } catch (err) {
          api.logger.warn(`[DunCrew] Golden Path distillation failed: ${err}`);
        }
      }
    });

    // ========================================
    // Register Gateway method: ddos.dun.list
    // ========================================
    api.registerGatewayMethod(
      "ddos.dun.list",
      async ({ context, respond }: any) => {
        captureBroadcast(context);
        const dunIds = dunManager.listDuns();
        const duns = dunIds
          .map((id: string) => {
            const meta = dunManager.loadDunMeta(id);
            if (!meta) return null;
            const xpData = dunManager.loadDunXP(id);
            return { ...meta, xp: xpData.xp, level: xpData.level };
          })
          .filter(Boolean);
        respond(true, { duns });
      }
    );

    // ========================================
    // Register Gateway method: ddos.dun.get
    // ========================================
    api.registerGatewayMethod(
      "ddos.dun.get",
      async ({ params, context, respond }: any) => {
        captureBroadcast(context);
        const dunId = params?.dunId as string;
        if (!dunId) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "dunId required" });
          return;
        }
        const meta = dunManager.loadDunMeta(dunId);
        if (!meta) {
          respond(false, undefined, { code: "NOT_FOUND", message: "Dun not found" });
          return;
        }
        const tracker = dunManager.getSOPTracker(dunId);
        const xpData = dunManager.loadDunXP(dunId);
        respond(true, {
          dun: { ...meta, xp: xpData.xp, level: xpData.level },
          sopTracker: tracker || null,
        });
      }
    );

    // ========================================
    // Register Gateway method: ddos.dun.activate
    // ========================================
    api.registerGatewayMethod(
      "ddos.dun.activate",
      async ({ params, context, respond }: any) => {
        captureBroadcast(context);
        const dunId = params?.dunId as string;
        if (!dunId) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "dunId required" });
          return;
        }
        const meta = dunManager.loadDunMeta(dunId);
        if (!meta) {
          respond(false, undefined, { code: "NOT_FOUND", message: "Dun not found" });
          return;
        }

        activeDunId = dunId;
        if (meta.sopContent) {
          dunManager.createSOPTracker(dunId, meta.name, meta.sopContent);
        }
        api.logger.info(`[DunCrew] Dun activated: ${meta.name}`);
        const xpData = dunManager.loadDunXP(dunId);
        respond(true, {
          ok: true,
          dun: { ...meta, xp: xpData.xp, level: xpData.level },
        });
      }
    );

    // ========================================
    // Register Gateway method: ddos.gene.status
    // Allow frontend to query Gene Pool state
    // ========================================
    api.registerGatewayMethod(
      "ddos.gene.status",
      async ({ context, respond }: any) => {
        captureBroadcast(context);
        respond(true, {
          geneCount: genePool.getGeneCount(),
        });
      }
    );

    api.logger.info(
      `[DunCrew] Extension registered. ${dunManager.listDuns().length} duns, ${genePool.getGeneCount()} genes found.`
    );
  },
};

export default plugin;
