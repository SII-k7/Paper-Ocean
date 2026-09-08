export const RELEASES_URL: string;
export interface ReleaseInfo { version: string; newer: boolean; checkedAt: number; url: string; }
export function newerRelease(candidate: string, current: string): boolean | null;
export function checkRelease(current: string, fetcher?: typeof fetch): Promise<ReleaseInfo>;
