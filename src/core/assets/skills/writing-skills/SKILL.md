---
name: writing-skills
description: Use when creating, editing, or reviewing a skill, or when a lesson from your work should become one.
---

# Writing Skills

A skill makes the next run predictable: same process, straight to the work. Write the smallest skill that does that.

## Steps

1. **Check the registry.** Run `skill_list` with a word from the task. Extend the skill that owns the procedure instead of adding a second one. A linked skill is read-only here: change it in its repository.
   - **Completion criterion**: you can name the skill you will create or edit, and why no other one owns this.
2. **Write the description.** State only when to use the skill: `Use when <trigger>`, one trigger per distinct way it is used, joined with "or". Leave out what the skill does and how.
   - **Completion criterion**: every phrase in it is a situation that should load the skill.
3. **Write the body.** Ordered steps, each an action with a checkable **completion criterion**; then the reference the steps need (rules, tables, templates). State the behavior you want; keep a prohibition only as a hard guardrail, paired with what to do instead. Name the tools the agent actually has.
   - **Completion criterion**: an agent that reads only this body can run the procedure without asking what a step means.
4. **Cut.** Read each sentence alone and delete it when the model would behave the same without it. One fact lives in one place: point to another skill instead of copying it. A skill an agent writes is a single file of at most 12,000 characters.
   - **Completion criterion**: every remaining sentence changes behavior.
5. **Save and attach.** `skill_create` or `skill_update` with the name, description, and body; the tool writes the frontmatter. Attach it with `agent_skills` to the agents that do the work, yourself included when you do.
   - **Completion criterion**: the tool confirmed the save, and `skill_list` shows the intended carriers.
