/**
 * DunCrew OpenClaw Extension — Main entry point.
 *
 * Registers hooks:
 *   - before_prompt_build: Inject System Brief, Nexus profile, SOP, Gene Pool hints
 *   - after_tool_call:     Track SOP progress, update recent entities, Gene Pool match + trace
 *   - llm_output:          Detect SOP adoption, parse ACTIVATE_NEXUS & SOP_REWRITE tags
 *   - session_start:       Initialize SOP tracker, reset Gene Pool session
 *   - agent_end:           Record experience, harvest genes, broadcast XP update
 *
 * All Nexus data is persisted in {dataDir}/nexuses/{nexusId}/ as plain files.
 * Gene Pool data is persisted in {dataDir}/genes/ as JSON files.
 */

import { join, dirname } from "path";
import { NexusManager, type SOPMode } from "./src/nexus-manager.js";
import { DDOS_SYSTEM_BRIEF } from "./src/system-brief.js";
import { ExtensionGenePool } from "./src/gene-pool.js";

// ============================================
// Plugin state (initialized in register())
// ============================================

let nexusManager: NexusManager;
let genePool: ExtensionGenePool;
let activeNexusId: string | null = null;
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
  nexusDataDir?: string;
  enableSOPInjection?: boolean;
  enableSOPEvolution?: boolean;
  enableNexusCatalog?: boolean;
  enableAnaphoraResolution?: boolean;
  enableExperienceRecording?: boolean;
  enableGenePool?: boolean;
  maxSOPContentLength?: number;
  recentEntityExpireMs?: number;
}

const DEFAULT_CONFIG: Required<DdosPluginConfig> = {
  nexusDataDir: "",
  enableSOPInjection: true,
  enableSOPEvolution: true,
  enableNexusCatalog: true,
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
// Helper: select active Nexus by trigger matching
// ============================================

function matchNexusByTrigger(
  query: string,
  manager: NexusManager
): string | null {
  const queryLower = query.toLowerCase();
  const nexusIds = manager.listNexuses();

  for (const nid of nexusIds) {
    const meta = manager.loadNexusMeta(nid);
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
    "Nexus-driven SOP execution, experience tracking, Gene Pool self-healing, and adaptive context injection for OpenClaw agents.",

  register(api: any) {
    const cfg = resolveConfig(api.pluginConfig);
    const dataDir = cfg.nexusDataDir || join(dirname(api.source), "data");
    nexusManager = new NexusManager(dataDir);
    genePool = new ExtensionGenePool(dataDir);

    api.logger.info(`[DunCrew] Nexus data dir: ${dataDir}`);
    api.logger.info(
      `[DunCrew] Config: SOP=${cfg.enableSOPInjection}, Anaphora=${cfg.enableAnaphoraResolution}, Experience=${cfg.enableExperienceRecording}, GenePool=${cfg.enableGenePool}`
    );
    api.logger.info(
      `[DunCrew] Loaded ${nexusManager.listNexuses().length} nexuses, ${genePool.getGeneCount()} genes`
    );

    // ========================================
    // Hook: before_prompt_build
    // T1: System Brief (cacheable, first time only)
    // T2: Nexus Profile (dynamic, every turn)
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

      // ── Auto-detect active Nexus from user message ──
      const userMessage = event?.userMessage || event?.message || "";
      if (!activeNexusId && userMessage) {
        activeNexusId = matchNexusByTrigger(userMessage, nexusManager);
        if (activeNexusId) {
          api.logger.info(`[DunCrew] Nexus matched by trigger: ${activeNexusId}`);
        }
      }

      // ── T2: Nexus Profile (every turn when active) ──
      if (activeNexusId) {
        const profile = nexusManager.buildNexusProfile(activeNexusId);
        if (profile) {
          dynamicParts.push(profile);
        }
      }

      // ── Existing: SOP context ──
      if (activeNexusId && cfg.enableSOPInjection) {
        if (promptBuildCount === 1) {
          const sopCtx = nexusManager.buildSOPContext(
            activeNexusId,
            cfg.maxSOPContentLength
          );
          if (sopCtx) {
            dynamicParts.push(sopCtx);
          }

          const evaluation = nexusManager.evaluateSOPApplicability(
            userMessage || sessionTaskMessage,
            activeNexusId
          );
          sopMode = evaluation.mode;
          sopActive = sopMode === "strict";
          sopFirstReply = sopMode === "optional";
          api.logger.info(
            `[DunCrew] SOP evaluation: mode=${sopMode}, reason="${evaluation.reason}"`
          );

          const directive = nexusManager.buildSOPDirective(activeNexusId, sopMode);
          if (directive) {
            dynamicParts.push("\n" + directive);
          }
        } else if (sopActive) {
          if (promptBuildCount - lastSOPReminderAt >= SOP_REMINDER_INTERVAL) {
            const reminder = nexusManager.buildSOPReminder(
              activeNexusId,
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
          const experiences = nexusManager.searchExperiences(
            activeNexusId,
            userMessage,
            3
          );
          if (experiences.length > 0) {
            dynamicParts.push(
              "\n--- Relevant Experience ---\n" + experiences.join("\n\n")
            );
          }
        }

        const rulesCtx = nexusManager.buildRulesContext(activeNexusId);
        if (rulesCtx) {
          dynamicParts.push("\n" + rulesCtx);
        }

        // ── SOP Evolution: improvement hints + rewrite request ──
        if (cfg.enableSOPEvolution && promptBuildCount === 1) {
          const sopHints = nexusManager.buildSOPImprovementHints(activeNexusId);
          if (sopHints) {
            dynamicParts.push("\n" + sopHints);
            api.logger.info("[DunCrew] SOP improvement hints injected");
          }

          const rewriteReq = nexusManager.buildSOPRewriteRequest(activeNexusId);
          if (rewriteReq) {
            dynamicParts.push("\n" + rewriteReq);
            api.logger.info("[DunCrew] SOP rewrite request injected");
          }
        }
      }

      // ── Nexus Catalog (when no active Nexus) ──
      if (!activeNexusId && cfg.enableNexusCatalog && promptBuildCount <= 2) {
        const catalog = nexusManager.buildNexusCatalog();
        if (catalog) {
          dynamicParts.push("\n" + catalog);
          api.logger.info("[DunCrew] Nexus catalog injected (no active Nexus)");
        }
      }

      // ── Existing: Anaphora resolution ──
      if (cfg.enableAnaphoraResolution) {
        const anaphoraHint = nexusManager.buildAnaphoraHint(
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
        nexusManager.updateRecentEntities(toolName, toolArgs, toolResult);
      }

      // Existing: Infer SOP progress
      if (activeNexusId && cfg.enableSOPInjection) {
        nexusManager.inferSOPProgress(activeNexusId, toolName, toolResult);
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
      if (activeNexusId && sopFirstReply && sopMode === "optional") {
        sopFirstReply = false;
        const adopted = nexusManager.detectSOPAdoption(responseText);
        sopActive = adopted;
        api.logger.info(
          `[DunCrew] SOP adoption detection: ${adopted ? "FOLLOW" : "FREE"}`
        );
      }

      // ── Nexus Catalog: parse <ACTIVATE_NEXUS> ──
      if (!activeNexusId && cfg.enableNexusCatalog) {
        const nexusMatch = responseText.match(
          /<ACTIVATE_NEXUS>(\S+)<\/ACTIVATE_NEXUS>/
        );
        if (nexusMatch) {
          const candidateId = nexusMatch[1];
          const meta = nexusManager.loadNexusMeta(candidateId);
          if (meta) {
            activeNexusId = candidateId;
            if (meta.sopContent) {
              nexusManager.createSOPTracker(
                candidateId,
                meta.name,
                meta.sopContent
              );
              const evaluation = nexusManager.evaluateSOPApplicability(
                sessionTaskMessage,
                candidateId
              );
              sopMode = evaluation.mode;
              sopActive = sopMode === "strict";
              sopFirstReply = sopMode === "optional";
            }
            api.logger.info(
              `[DunCrew] Agent activated Nexus: ${candidateId} (${meta.name})`
            );
            if (broadcastFn) {
              try {
                const xpData = nexusManager.loadNexusXP(candidateId);
                broadcastFn("ddos.nexus.activated", {
                  nexusId: candidateId,
                  nexusName: meta.name,
                  xp: xpData.xp,
                  level: xpData.level,
                  activatedBy: "agent",
                });
              } catch (err) {
                api.logger.warn(
                  `[DunCrew] Failed to broadcast Nexus activation: ${err}`
                );
              }
            }
          } else {
            api.logger.warn(
              `[DunCrew] Agent tried to activate unknown Nexus: ${candidateId}`
            );
          }
        }
      }

      // ── SOP Evolution: parse <SOP_REWRITE> ──
      if (activeNexusId && cfg.enableSOPEvolution) {
        const sopMatch = responseText.match(
          /<SOP_REWRITE>([\s\S]*?)<\/SOP_REWRITE>/
        );
        if (sopMatch) {
          const newSOP = sopMatch[1].trim();
          if (newSOP.length > 50) {
            const written = nexusManager.writeSOPContent(
              activeNexusId,
              newSOP
            );
            if (written) {
              nexusManager.resetSOPFitnessAfterRewrite(activeNexusId);
              api.logger.info(
                `[DunCrew] SOP rewritten by Agent for Nexus: ${activeNexusId}`
              );
              if (broadcastFn) {
                try {
                  broadcastFn("ddos.nexus.sopUpdated", {
                    nexusId: activeNexusId,
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
      if (activeNexusId) {
        const bindMatches = responseText.matchAll(
          /<BIND_SKILL>([^<]+)<\/BIND_SKILL>/g
        );
        for (const match of bindMatches) {
          const skillName = match[1].trim();
          if (skillName) {
            api.logger.info(
              `[DunCrew] Agent binding skill "${skillName}" to Nexus ${activeNexusId}`
            );
            if (broadcastFn) {
              try {
                broadcastFn("ddos.nexus.skillBound", {
                  nexusId: activeNexusId,
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
      activeNexusId = null;
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

      // Auto-match Nexus from initial message
      if (sessionTaskMessage) {
        activeNexusId = matchNexusByTrigger(sessionTaskMessage, nexusManager);
      }

      // Initialize SOP tracker
      if (activeNexusId) {
        const meta = nexusManager.loadNexusMeta(activeNexusId);
        if (meta?.sopContent) {
          nexusManager.createSOPTracker(
            activeNexusId,
            meta.name,
            meta.sopContent
          );
          api.logger.info(
            `[DunCrew] SOP tracker initialized for Nexus: ${meta.name}`
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
        `[DunCrew][DEBUG] agent_end: activeNexusId=${activeNexusId}, enableGenePool=${cfg.enableGenePool}, traceLength=${genePool.getSessionTrace().length}`
      );

      const duration = event?.durationMs || (Date.now() - sessionStartTime);
      const isSuccess = event?.success === true;
      const isError = !isSuccess;

      api.logger.info(
        `[DunCrew][DEBUG] agent_end: success=${event?.success}, isSuccess=${isSuccess}, isError=${isError}`
      );

      // ── Existing: Record experience ──
      if (activeNexusId && cfg.enableExperienceRecording && sessionTaskMessage) {
        nexusManager.recordExperience(
          activeNexusId,
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
          `[DunCrew] Experience recorded for ${activeNexusId}: ${isError ? "failure" : "success"} (${Math.round(duration / 1000)}s)`
        );
      }

      // ── T4: Gene Pool harvesting ──
      if (cfg.enableGenePool) {
        const traceSnapshot = genePool.getSessionTrace();
        api.logger.info(
          `[DunCrew][DEBUG] Gene Pool harvest check: traceLength=${traceSnapshot.length}, activeNexus=${activeNexusId}`
        );
        if (traceSnapshot.length > 0) {
          api.logger.info(
            `[DunCrew][DEBUG] Session trace statuses: [${traceSnapshot.map(t => `${t.name}:${t.status}`).join(", ")}]`
          );
        }
        const harvested = genePool.harvestGenes(activeNexusId || undefined);
        if (harvested.length > 0) {
          api.logger.info(
            `[DunCrew] Gene Pool: harvested ${harvested.length} new gene(s) for ${activeNexusId || "global"}`
          );
        } else {
          api.logger.info(
            `[DunCrew][DEBUG] Gene Pool: no genes harvested (no error->success pairs found)`
          );
        }
      }

      // ── T5: XP calculation and broadcast ──
      if (activeNexusId) {
        let xpDelta = 0;
        if (isSuccess) {
          xpDelta = 10; // Base success XP
          if (sessionToolsUsed.length > 3) xpDelta += 5; // Complex task bonus
          if (sopActive) xpDelta += 5; // SOP adherence bonus
        } else {
          xpDelta = -2; // Failure penalty
        }

        const currentXP = nexusManager.loadNexusXP(activeNexusId);
        const newXP = Math.max(0, currentXP.xp + xpDelta);
        nexusManager.saveNexusXP(activeNexusId, newXP);
        const newLevel = NexusManager.xpToLevel(newXP);

        api.logger.info(
          `[DunCrew] XP update: ${activeNexusId} ${xpDelta > 0 ? "+" : ""}${xpDelta} → XP ${newXP} (Lv${newLevel})`
        );

        // Broadcast to DunCrew frontend
        if (broadcastFn) {
          try {
            broadcastFn("ddos.nexus.xpUpdate", {
              nexusId: activeNexusId,
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
      if (activeNexusId && cfg.enableSOPEvolution) {
        try {
          const sessionTrace = genePool.getSessionTrace();
          const sopTracker = nexusManager.getSOPTracker(activeNexusId);
          const { fitness, traceSummary } =
            nexusManager.computeSessionFitness(sessionTrace, sopTracker ?? null, isSuccess);
          const updatedFitness =
            nexusManager.updateSOPFitness(activeNexusId, traceSummary);
          api.logger.info(
            `[DunCrew] SOP fitness: ${(fitness * 100).toFixed(0)}%, ema: ${(updatedFitness.ema * 100).toFixed(0)}% (${updatedFitness.totalExecutions} executions)`
          );
        } catch (err) {
          api.logger.warn(`[DunCrew] SOP fitness update failed: ${err}`);
        }
      }
    });

    // ========================================
    // Register Gateway method: ddos.nexus.list
    // ========================================
    api.registerGatewayMethod(
      "ddos.nexus.list",
      async ({ context, respond }: any) => {
        captureBroadcast(context);
        const nexusIds = nexusManager.listNexuses();
        const nexuses = nexusIds
          .map((id: string) => {
            const meta = nexusManager.loadNexusMeta(id);
            if (!meta) return null;
            const xpData = nexusManager.loadNexusXP(id);
            return { ...meta, xp: xpData.xp, level: xpData.level };
          })
          .filter(Boolean);
        respond(true, { nexuses });
      }
    );

    // ========================================
    // Register Gateway method: ddos.nexus.get
    // ========================================
    api.registerGatewayMethod(
      "ddos.nexus.get",
      async ({ params, context, respond }: any) => {
        captureBroadcast(context);
        const nexusId = params?.nexusId as string;
        if (!nexusId) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "nexusId required" });
          return;
        }
        const meta = nexusManager.loadNexusMeta(nexusId);
        if (!meta) {
          respond(false, undefined, { code: "NOT_FOUND", message: "Nexus not found" });
          return;
        }
        const tracker = nexusManager.getSOPTracker(nexusId);
        const xpData = nexusManager.loadNexusXP(nexusId);
        respond(true, {
          nexus: { ...meta, xp: xpData.xp, level: xpData.level },
          sopTracker: tracker || null,
        });
      }
    );

    // ========================================
    // Register Gateway method: ddos.nexus.activate
    // ========================================
    api.registerGatewayMethod(
      "ddos.nexus.activate",
      async ({ params, context, respond }: any) => {
        captureBroadcast(context);
        const nexusId = params?.nexusId as string;
        if (!nexusId) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "nexusId required" });
          return;
        }
        const meta = nexusManager.loadNexusMeta(nexusId);
        if (!meta) {
          respond(false, undefined, { code: "NOT_FOUND", message: "Nexus not found" });
          return;
        }

        activeNexusId = nexusId;
        if (meta.sopContent) {
          nexusManager.createSOPTracker(nexusId, meta.name, meta.sopContent);
        }
        api.logger.info(`[DunCrew] Nexus activated: ${meta.name}`);
        const xpData = nexusManager.loadNexusXP(nexusId);
        respond(true, {
          ok: true,
          nexus: { ...meta, xp: xpData.xp, level: xpData.level },
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
      `[DunCrew] Extension registered. ${nexusManager.listNexuses().length} nexuses, ${genePool.getGeneCount()} genes found.`
    );
  },
};

export default plugin;
