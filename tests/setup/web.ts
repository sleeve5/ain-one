import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: ResizeObserverMock });

afterEach(() => {
  cleanup();
  globalThis.localStorage?.clear();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});
