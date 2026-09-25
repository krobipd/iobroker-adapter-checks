import { adminI18nCheck } from "./checks/admin-i18n.js";
import { caughtValueTextCheck } from "./checks/caught-value-text.js";
import { changelogCountCheck } from "./checks/changelog-count.js";
import { changelogStyleCheck } from "./checks/changelog-style.js";
import { commonDocsCheck } from "./checks/common-docs.js";
import { deprecatedAdapterMethodsCheck } from "./checks/deprecated-adapter-methods.js";
import { errorTextSelfStateCheck } from "./checks/error-text-selfstate.js";
import { fetchStubResponseCheck } from "./checks/fetch-stub-response.js";
import { firstReplyWorkflowCheck } from "./checks/first-reply-workflow.js";
import { instanceObjectsRefreshCheck } from "./checks/instance-objects-refresh.js";
import { issueFormsCheck } from "./checks/issue-forms.js";
import { listenPortDeclarationCheck } from "./checks/listen-port-declaration.js";
import { englishOnlyCheck } from "./checks/english-only.js";
import { errorTextHelperCheck } from "./checks/error-text-helper.js";
import { errorTextReasonCheck } from "./checks/error-text-reason.js";
import { fireAndForgetRejectionCheck } from "./checks/fire-and-forget-rejection.js";
import { localArtifactsCheck } from "./checks/local-artifacts.js";
import { messageboxRepairCheck } from "./checks/messagebox-repair.js";
import { readmeRequirementsCheck } from "./checks/readme-requirements.js";
import { releaseDeployGateCheck } from "./checks/release-deploy-gate.js";
import { nodeMatrixCheck } from "./checks/node-matrix.js";
import { objectDeleteDropsStateCheck } from "./checks/object-delete-drops-state.js";
import { encryptedNativeWriteCheck } from "./checks/encrypted-native-write.js";
import { objectRewriteCheck } from "./checks/object-rewrite.js";
import { overrideBelowParentCheck } from "./checks/override-below-parent.js";
import { readStubCopyCheck } from "./checks/read-stub-copy.js";
import { sentryDisclosureCheck } from "./checks/sentry-disclosure.js";
import { secretFieldsCheck } from "./checks/secret-fields.js";
import { stopInstanceCheck } from "./checks/stop-instance.js";
import { switchDefaultCheck } from "./checks/switch-default.js";
import type { Check, Finding, RunOptions } from "./types.js";

export type { Check, CheckOptions, Finding, RunOptions } from "./types.js";
export {
  adminI18nCheck,
  caughtValueTextCheck,
  changelogCountCheck,
  changelogStyleCheck,
  commonDocsCheck,
  deprecatedAdapterMethodsCheck,
  englishOnlyCheck,
  encryptedNativeWriteCheck,
  errorTextHelperCheck,
  errorTextReasonCheck,
  errorTextSelfStateCheck,
  fetchStubResponseCheck,
  fireAndForgetRejectionCheck,
  firstReplyWorkflowCheck,
  instanceObjectsRefreshCheck,
  issueFormsCheck,
  listenPortDeclarationCheck,
  localArtifactsCheck,
  messageboxRepairCheck,
  nodeMatrixCheck,
  objectDeleteDropsStateCheck,
  objectRewriteCheck,
  overrideBelowParentCheck,
  readStubCopyCheck,
  readmeRequirementsCheck,
  releaseDeployGateCheck,
  secretFieldsCheck,
  sentryDisclosureCheck,
  stopInstanceCheck,
  switchDefaultCheck,
};

/** Every check this package ships, in a stable order. */
export const allChecks: readonly Check[] = [
  switchDefaultCheck,
  stopInstanceCheck,
  sentryDisclosureCheck,
  errorTextSelfStateCheck,
  adminI18nCheck,
  changelogCountCheck,
  changelogStyleCheck,
  englishOnlyCheck,
  localArtifactsCheck,
  nodeMatrixCheck,
  readmeRequirementsCheck,
  secretFieldsCheck,
  issueFormsCheck,
  firstReplyWorkflowCheck,
  releaseDeployGateCheck,
  commonDocsCheck,
  instanceObjectsRefreshCheck,
  messageboxRepairCheck,
  listenPortDeclarationCheck,
  fetchStubResponseCheck,
  objectRewriteCheck,
  deprecatedAdapterMethodsCheck,
  caughtValueTextCheck,
  errorTextHelperCheck,
  errorTextReasonCheck,
  objectDeleteDropsStateCheck,
  fireAndForgetRejectionCheck,
  readStubCopyCheck,
  overrideBelowParentCheck,
  encryptedNativeWriteCheck,
];

/**
 * Run every check against one adapter repository.
 *
 * Reads files only — no writes, no network, no child processes — so it is safe to call
 * from a unit test on any developer machine and in CI.
 *
 * @param adapterDir the adapter repository root (where package.json sits)
 * @param options optional ids to skip
 * @returns all findings, in check order; empty means the adapter is clean
 */
export function runChecks(
  adapterDir: string,
  options: RunOptions = {},
): Finding[] {
  const skip = new Set(options.skip ?? []);
  const findings: Finding[] = [];
  for (const check of allChecks) {
    if (skip.has(check.id)) {
      continue;
    }
    findings.push(...check.run(adapterDir, options));
  }
  return findings;
}

/**
 * Render findings as a block a developer can act on straight from the test output.
 *
 * @param findings what {@link runChecks} returned
 * @returns one line per finding, empty string when there is nothing to report
 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      const impact = f.impact ? ` — ${f.impact}` : "";
      return `[${f.check}] ${where}: ${f.message}${impact}`;
    })
    .join("\n");
}
