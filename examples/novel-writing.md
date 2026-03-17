# Example: Novel Writing with novel-master Nexus

## Scenario

Using the `novel-master` Nexus to plan and write the first chapter of a sci-fi novel.

## Setup

1. Ensure DD-OS is running (frontend + backend)
2. Configure your LLM API in Settings (GPT-4o or DeepSeek recommended for creative tasks)
3. The `novel-master` Nexus is preinstalled -- click it on the World View to enter

## Prompt

```
I want to write a hard sci-fi novel called "The Last Signal". 
Setting: 2187, humanity has colonized Mars but lost contact with Earth 3 years ago. 
A radio engineer on Mars Station Helios discovers a faint signal from Earth.

Please start from Phase 1 (Project Setup) of your SOP.
```

## What Happens

The novel-master Nexus follows its 5-phase SOP:

### Phase 1: Project Setup

The AI automatically:
1. Creates a project directory structure:
   ```
   novel-the-last-signal/
   ├── worldbuilding.md    # Setting, tech level, society rules
   ├── characters.md       # Character profiles
   ├── outline.md          # Full novel outline
   └── chapters/
       └── chapter-01.md   # First chapter draft
   ```
2. Establishes core setting rules (hard sci-fi constraints, Mars colonization tech)
3. Saves project context to L1 memory for persistence

### Phase 2: Character Design

The AI creates detailed character profiles with:
- Backstory and motivations
- Voice and speech patterns
- Relationship dynamics
- Internal conflicts

### Phase 3: Outline

A chapter-by-chapter outline with:
- Plot arc structure (setup, rising action, climax, resolution)
- Per-chapter scene breakdowns
- Foreshadowing threads and cliffhangers

### Phase 4: Chapter Writing

The AI writes each chapter following the outline:
- Uses `writeFile` to save each chapter
- Maintains consistency via L1 memory (remembers character traits, plot threads)
- Applies `diverse-ideation` skill for creative variations
- Self-reviews with `structured-reasoning` skill

### Phase 5: Review & Polish

- Reads back completed chapters with `readFile`
- Checks for plot holes, pacing issues, voice consistency
- Generates revision notes

## Key Features Demonstrated

| Feature | How It's Used |
|---------|--------------|
| **Nexus SOP** | 5-phase structured workflow guides the entire process |
| **L1 Memory** | Character traits, plot decisions persist across sessions |
| **File Registry** | All novel files auto-tracked, no re-exploration needed |
| **Bound Skills** | `prose` + `diverse-ideation` + `structured-reasoning` work together |
| **Scoring** | Each execution builds the Nexus's writing score over time |

## Tips

- Break the work into sessions -- the Nexus remembers where you left off
- Use "continue from Chapter 3" style prompts to resume
- If the AI's style drifts, say "review the character profiles and adjust tone"
- The more you use novel-master, the higher its confidence score, and the better its writing patterns become through Gene Pool harvesting
