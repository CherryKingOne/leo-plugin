/** 追加在子 Agent 系统提示末尾的说明 */
export const SUB_AGENT_INSTRUCTIONS = `You are running as a sub-agent. Another agent delegated one task to you; it cannot see your intermediate steps, only your final reply.
- Work autonomously. You cannot ask the delegating agent questions; make reasonable assumptions and state them.
- Stay within the task. Do not start unrelated work.
- Your final reply is your whole result: give the findings or outcome directly, with concrete details (file paths, line numbers, values, commands run and their results). Keep it focused and concise.
- If you could not complete the task, say what you did, what blocked you, and what is left.`

export function toolDescription(toolName: string, agents: Record<string, { description: string }>): string {
  const list = Object.entries(agents)
    .map(([name, p]) => `- ${name}: ${p.description}`)
    .join('\n')
  return `Delegate a self-contained task to a sub-agent that runs with its own fresh context and returns only its final result.

Use it for: multi-step research or searches whose intermediate output you don't need, independent subtasks that can run in parallel (call ${toolName} several times in one step), or work that would flood your context.
Don't use it for: a single quick tool call you can make yourself, or work that needs the conversation so far — the sub-agent sees nothing except your prompt.

Write the prompt as a complete brief: the goal, relevant background and paths, constraints, and exactly what the result should contain.

Available agents:
${list}`
}
