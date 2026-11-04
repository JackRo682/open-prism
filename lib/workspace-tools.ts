export type WorkspaceTool = 'chat' | 'canvas' | 'research' | 'learning' | 'image' | 'video';
export type ResearchSources = { web: boolean };

/** These flags describe integrations actually implemented by this deployment. */
export const workspaceCapabilities = Object.freeze({
  webResearch: false,
  image: false,
  video: false,
  remoteBrowser: false,
});

export class WorkspaceToolError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

const tools = new Set<WorkspaceTool>(['chat', 'canvas', 'research', 'learning', 'image', 'video']);

export function validateToolRequest(body: Record<string, unknown>): {
  tool: WorkspaceTool;
  researchSources: ResearchSources;
} {
  const tool = body.tool === undefined ? 'chat' : body.tool;
  if (typeof tool !== 'string' || !tools.has(tool as WorkspaceTool)) {
    throw new WorkspaceToolError('올바른 작업 도구를 선택해주세요.', 400, 'INVALID_TOOL');
  }
  let web = false;
  if (body.researchSources !== undefined) {
    const sources = body.researchSources;
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)
      || Object.keys(sources).some(key => key !== 'web')
      || typeof (sources as Record<string, unknown>).web !== 'boolean') {
      throw new WorkspaceToolError('리서치 소스를 올바르게 선택해주세요.', 400, 'INVALID_RESEARCH_SOURCES');
    }
    web = (sources as ResearchSources).web;
  }
  // A text provider key does not enable a media endpoint or cover its costs.
  // Reject before reservations, conversation writes, or external API access.
  if (tool === 'image' || tool === 'video') {
    throw new WorkspaceToolError(
      `${tool === 'image' ? '이미지' : '동영상'} 생성 서비스가 아직 연결되지 않았습니다. 요청이 전송되지 않았으며 사용량이 차감되지 않습니다.`,
      503,
      tool === 'image' ? 'IMAGE_GENERATION_NOT_CONFIGURED' : 'VIDEO_GENERATION_NOT_CONFIGURED',
    );
  }
  if (tool === 'research' && web) {
    throw new WorkspaceToolError(
      '웹 리서치가 아직 연결되지 않았습니다. 소스에서 웹 검색을 끄고 직접 제공한 자료나 첨부 파일을 분석할 수 있습니다.',
      503,
      'WEB_RESEARCH_NOT_CONFIGURED',
    );
  }
  return { tool: tool as WorkspaceTool, researchSources: { web } };
}

/** Mode instructions are sent to the real provider, never stored as user text. */
export function withToolContext(prompt: string, tool: WorkspaceTool): string {
  if (tool === 'chat') return prompt;
  const instructions: Partial<Record<WorkspaceTool, string>> = {
    canvas: 'The user selected Canvas. Produce a complete, editable draft, document, or code artifact appropriate to the request. Keep the artifact coherent and put any commentary after it. For code, identify filenames and use language-labelled code fences. You can generate and revise text, but you cannot run code, deploy a website, or modify external files. Do not claim that you performed those actions.',
    learning: 'The user selected Guided Learning. Adapt to their stated knowledge level. Explain ideas in small steps with concrete examples, then offer one useful check-for-understanding question. If they ask for a direct answer, provide it before the explanation. Do not invent progress, mastery, or quiz results the user has not demonstrated.',
    research: 'The user selected source-based research. This request has NO web search, browsing, or background research agent. Base factual conclusions on text and attached documents actually supplied in this conversation. Cite supplied document names and sections when available; never invent source URLs, quotations, page numbers, or claims that you searched online. Separate source-supported findings from inference and identify missing or outdated evidence. If no relevant evidence was supplied, ask for the source text or a file and provide only a research outline. Clearly state that this is analysis of provided material, not live web research.',
  };
  const instruction = instructions[tool];
  if (!instruction) throw new WorkspaceToolError('이 도구는 현재 사용할 수 없습니다.', 503, 'TOOL_NOT_CONFIGURED');
  return `${instruction}\n\nUser request and supplied material:\n${prompt}`;
}
