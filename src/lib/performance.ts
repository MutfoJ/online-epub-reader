export interface DevicePerformanceProfile {
  constrained: boolean;
  mobileLike: boolean;
  cores: number;
  memoryGb: number | null;
}

export function getDevicePerformanceProfile(): DevicePerformanceProfile {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const cores = Math.max(1, Number(nav?.hardwareConcurrency || 4));
  const memoryGb = Number((nav as any)?.deviceMemory || 0) || null;
  const mobileLike =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(pointer: coarse)")?.matches ||
      window.matchMedia?.("(max-width: 720px)")?.matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent || ""));

  return {
    constrained: mobileLike || cores <= 4 || (memoryGb !== null && memoryGb <= 4),
    mobileLike,
    cores,
    memoryGb,
  };
}

export function getImportConcurrency(): number {
  const profile = getDevicePerformanceProfile();
  return profile.constrained ? 1 : 2;
}

export function getAnalysisConcurrency(): number {
  const profile = getDevicePerformanceProfile();
  return profile.constrained ? 1 : 3;
}

export function shouldDeferEpubAnalysis(fileSize: number): boolean {
  const profile = getDevicePerformanceProfile();
  if (!profile.constrained) return false;
  return fileSize >= 18 * 1024 * 1024;
}

export function requestIdleWork(task: () => void, timeout = 12000): void {
  if (typeof window === "undefined") return;
  const idle = (window as any).requestIdleCallback as
    | ((callback: () => void, options?: { timeout?: number }) => number)
    | undefined;

  if (typeof idle === "function") {
    idle(task, { timeout });
    return;
  }

  window.setTimeout(task, Math.min(timeout, 4000));
}
