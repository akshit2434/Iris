export const CHAT_SCROLL_THRESHOLD = 120;

export type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export type ScrollFollowState = {
  nearBottom: boolean;
  manual: boolean;
  follow: boolean;
};

export const INITIAL_SCROLL_FOLLOW_STATE: ScrollFollowState = {
  nearBottom: true,
  manual: false,
  follow: true,
};

export function measureScrollFollowState(metrics: ScrollMetrics, threshold = CHAT_SCROLL_THRESHOLD): ScrollFollowState {
  const nearBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
  return { nearBottom, manual: !nearBottom, follow: nearBottom };
}

export function returnToBottomState(): ScrollFollowState {
  return INITIAL_SCROLL_FOLLOW_STATE;
}
