import { timingSafeEqual } from "node:crypto";

export function hasWorkerSecret(supplied: string, expected = process.env.MEMORY_WORKER_SECRET) {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
