---
name: critical-evaluation
description: "Systematic critical evaluation framework for analyzing arguments, detecting cognitive biases, and improving decision quality. Use for complex decisions, debate analysis, and identifying logical fallacies."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🔍"
    primaryEnv: "shell"
---

# Critical Evaluation Skill

A systematic framework for analyzing arguments, detecting cognitive biases, and improving decision quality through structured critical thinking.

## When to Use This Skill

1. **Complex decisions** with significant consequences
2. **Evaluating arguments** or debates
3. **Reviewing proposals** or plans
4. **Analyzing conflicting information**
5. **Before making important recommendations**
6. **When cognitive biases may be influencing judgment**

## The Critical Evaluation Framework

### Phase 1: Argument Deconstruction
Break down the argument or decision into core components:
1. **Claim**: What is being asserted?
2. **Evidence**: What supports the claim?
3. **Reasoning**: How does evidence connect to claim?
4. **Assumptions**: What is being taken for granted?
5. **Counterarguments**: What opposing views exist?

### Phase 2: Cognitive Bias Detection
Check for common cognitive biases:

| Bias | Description | Questions to Ask |
|------|-------------|------------------|
| **Confirmation Bias** | Seeking information that confirms existing beliefs | "Am I ignoring contradictory evidence?" |
| **Anchoring Bias** | Relying too heavily on first piece of information | "Did the initial information distort my judgment?" |
| **Availability Heuristic** | Overestimating importance of recent/memorable info | "Am I overweighing vivid examples?" |
| **Dunning-Kruger Effect** | Overestimating one's own competence | "Do I really have the expertise needed?" |
| **Sunk Cost Fallacy** | Continuing because of past investment | "Am I letting past costs influence future decisions?" |
| **Groupthink** | Conforming to group opinion | "Am I agreeing just to maintain harmony?" |
| **Framing Effect** | Being influenced by how info is presented | "Would I decide differently if framed another way?" |

### Phase 3: Logical Fallacy Detection
Identify common logical fallacies:

| Fallacy | Pattern | Example |
|---------|---------|---------|
| **Ad Hominem** | Attacking person, not argument | "His idea is bad because he's inexperienced" |
| **Straw Man** | Misrepresenting opponent's position | "You want to destroy the economy" (from "regulate pollution") |
| **False Dilemma** | Presenting only two options | "Either we cut costs or we go bankrupt" |
| **Slippery Slope** | Assuming one step leads to catastrophe | "If we allow this, then everything will collapse" |
| **Appeal to Authority** | Using authority as evidence | "Expert X says so, so it must be true" |
| **Correlation ≠ Causation** | Assuming causation from correlation | "Ice cream sales increase with drownings" |
| **Hasty Generalization** | Conclusion from insufficient evidence | "Two failures mean the whole approach is wrong" |

### Phase 4: Evidence Quality Assessment
Evaluate the quality of evidence:

1. **Source credibility**: Expert, biased, reputable?
2. **Recency**: How current is the information?
3. **Methodology**: How was evidence gathered?
4. **Sample size**: Is it statistically significant?
5. **Replicability**: Can results be reproduced?
6. **Conflict of interest**: Are there ulterior motives?

### Phase 5: Alternative Perspectives
Deliberately consider opposing views:

1. **Devil's Advocate**: Argue against your own position
2. **Red Team**: Attack the decision as an adversary would
3. **Multiple Scenarios**: Consider best/worst/most likely cases
4. **Long-term View**: How will this look in 5 years?
5. **Outside View**: How have similar situations played out?

### Phase 6: Confidence Calibration
Assess and communicate uncertainty:

1. **Confidence Level**: High/Medium/Low with reasoning
2. **Key Uncertainties**: What we don't know
3. **Information Gaps**: What would help reduce uncertainty
4. **Sensitivity Analysis**: Which assumptions matter most

## Application Templates

### Decision Evaluation Template
```
## Decision: [Brief description]

### 1. Core Components
- Claim: 
- Evidence: 
- Reasoning: 
- Assumptions: 

### 2. Bias Check
- Confirmation bias risk: [High/Medium/Low]
- Anchoring bias risk: [High/Medium/Low]
- Other biases identified: 

### 3. Fallacy Check
- Logical fallacies found: 
- Argument weaknesses: 

### 4. Evidence Quality
- Source credibility: 
- Methodology strength: 
- Key limitations: 

### 5. Alternative Perspectives
- Devil's advocate view: 
- Red team concerns: 
- Scenario analysis: 

### 6. Recommendation
- Confidence level: [High/Medium/Low]
- Key uncertainties: 
- Final recommendation: 
```

### Argument Analysis Template
```
## Argument Analysis

### Original Argument
[Quote or summarize]

### Deconstruction
1. **Claim**: 
2. **Evidence**: 
3. **Reasoning**: 
4. **Assumptions**: 

### Critical Assessment
- **Strengths**: 
- **Weaknesses**: 
- **Biases detected**: 
- **Fallacies identified**: 

### Improved Argument
[How to strengthen the argument]
```

## Integration with Other Skills

### With Structured Reasoning
Use critical evaluation as a validation phase in the structured reasoning flywheel:
1. **Phase 5: Validation** → Apply critical evaluation
2. **Phase 6: Decision** → Incorporate critical insights
3. **Phase 7: Review** → Include bias awareness

### With Self-Improving Agent
Log critical evaluation insights:
- Decision patterns with bias risk
- Successful bias mitigation strategies
- Common fallacies in domain

### With Diverse Ideation
Ensure ideation avoids:
- Groupthink in brainstorming
- Anchoring on first ideas
- Confirmation bias in idea selection

## Examples

### Example 1: Business Decision
**Situation**: "Should we launch Product X?"
**Critical Evaluation**:
1. Deconstruct: Claim (launch will succeed), Evidence (market research), Assumptions (no competitor response)
2. Bias check: Confirmation bias (only researched positive outcomes), Sunk cost fallacy (already spent $500k)
3. Fallacy check: False dilemma (launch vs. abandon, no middle ground)
4. Evidence: Research methodology flaws (small sample, leading questions)
5. Alternatives: Soft launch, pivot, partner with existing player
6. Confidence: Medium (due to competitor uncertainty)

### Example 2: Technical Architecture
**Situation**: "Microservices are always better than monoliths"
**Critical Evaluation**:
1. Deconstruct: Absolute claim, evidence (scalability needs), assumptions (team ready for complexity)
2. Bias check: Availability heuristic (recent microservices success stories), Bandwagon effect (everyone's doing it)
3. Fallacy check: Hasty generalization (from few examples), False dilemma (only two options)
4. Evidence: Case studies lack context (team size, domain)
5. Alternatives: Modular monolith, hybrid approach
6. Confidence: Low claim (not "always"), High for specific context

## Implementation Notes

### When NOT to Use
- Simple factual questions
- Time-sensitive emergencies  
- Low-stakes decisions
- When heuristic clearly applies

### Skill Activation Cues
- "Critically evaluate..."
- "What are the weaknesses of..."
- "Play devil's advocate for..."
- "Identify biases in..."
- "What assumptions are we making..."

### Tool Integration
- **memory_search**: Find similar past decisions
- **web_search**: Gather counter-evidence
- **sessions_spawn**: Create devil's advocate agent
- **write_file**: Document evaluation

## Continuous Improvement

Track effectiveness:
1. **Decision outcomes** vs. critical evaluation predictions
2. **Bias detection accuracy**
3. **Common patterns** in your thinking
4. **Adjust framework** based on results

## References
- Kahneman, D. (2011). Thinking, Fast and Slow
- Tetlock, P. (2015). Superforecasting
- Heath, C. & Heath, D. (2013). Decisive