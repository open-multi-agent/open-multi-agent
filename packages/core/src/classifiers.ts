/**
 * Optional risk classifiers, shipped behind the `@open-multi-agent/core/classifiers`
 * subpath so their pattern tables never load unless imported. Convenience
 * helpers for `onToolCallGate` policies — not part of the core import surface.
 */
export type { BashRiskLevel, BashRiskAssessment } from './tool/classifiers/bash-risk.js'
export { classifyBashCommand } from './tool/classifiers/bash-risk.js'
