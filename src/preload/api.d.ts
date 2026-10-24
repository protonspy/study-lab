import type { Bridge } from "@shared/api"

declare global {
  interface Window {
    studyLab: Bridge
  }
}

export {}
