import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ACCESS_COOKIE = "iris-access";

export function getAppPin() {
  const pin = process.env.IRIS_APP_PIN;
  if (!pin) {
    throw new Error("IRIS_APP_PIN is not configured.");
  }
  return pin;
}

export function getAccessToken(pin: string) {
  return createHash("sha256").update(`iris-access:${pin}`).digest("hex");
}

function tokensMatch(received: string | undefined, expected: string) {
  if (!received) {
    return false;
  }

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export async function hasAppAccess() {
  try {
    const cookieStore = await cookies();
    return tokensMatch(cookieStore.get(ACCESS_COOKIE)?.value, getAccessToken(getAppPin()));
  } catch {
    return false;
  }
}

export async function assertAppAccess() {
  if (!(await hasAppAccess())) {
    throw new Error("Iris app access is required.");
  }
}
