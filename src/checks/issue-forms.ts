import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readText } from "../util.js";

const DIR = ".github/ISSUE_TEMPLATE";

/**
 * File names in the issue-template directory, sorted.
 *
 * @param adapterDir the adapter repository root
 * @returns the names, or undefined when the directory does not exist
 */
function templateFiles(adapterDir: string): string[] | undefined {
  try {
    return readdirSync(join(adapterDir, DIR)).sort();
  } catch {
    return undefined;
  }
}

/**
 * Issue forms guide a reporter to the facts a maintainer needs — adapter version, controller
 * version, log, steps. A repository without forms, or one that still allows blank issues, gets
 * reports that begin with a question back to the reporter.
 *
 * Expected: at least one form (a YAML file with `name:` and `body:`), a `config.yml` with
 * `blank_issues_enabled: false`, and no legacy Markdown template beside the forms — GitHub
 * offers it next to them as a second, unguided entry that skips every field a form asks for.
 */
export const issueFormsCheck: Check = {
  id: "issue-forms",
  title: "issue forms guide every new report",
  run(adapterDir: string): Finding[] {
    const finding = (
      file: string,
      message: string,
      impact: string,
    ): Finding => ({
      check: issueFormsCheck.id,
      file,
      message,
      impact,
    });
    const files = templateFiles(adapterDir);
    if (files === undefined) {
      return [
        finding(
          DIR,
          "no .github/ISSUE_TEMPLATE directory — a new issue opens in a blank editor",
          "reports arrive without adapter version, log or steps, and the first reply is a question back to the reporter",
        ),
      ];
    }
    const out: Finding[] = [];
    // GitHub documents exactly one chooser file, `config.yml`; a `config.yaml` is not read.
    const isConfig = (f: string): boolean => f === "config.yml";
    const forms = files.filter(
      (f) => /\.ya?ml$/i.test(f) && !/^config\.ya?ml$/i.test(f),
    );
    const isForm = (f: string): boolean => {
      const text = readText(adapterDir, `${DIR}/${f}`) ?? "";
      return /^name:/m.test(text) && /^body:/m.test(text);
    };
    if (!forms.some(isForm)) {
      out.push(
        finding(
          DIR,
          "no issue form (a YAML file with `name:` and `body:`) in .github/ISSUE_TEMPLATE",
          "reports arrive without adapter version, log or steps, and the first reply is a question back to the reporter",
        ),
      );
    }
    const config = files.find(isConfig);
    const configText =
      config === undefined
        ? undefined
        : (readText(adapterDir, `${DIR}/${config}`) ?? "");
    if (configText === undefined) {
      const yaml = files.find(
        (f) => /^config\.ya?ml$/i.test(f) && f !== "config.yml",
      );
      out.push(
        finding(
          `${DIR}/config.yml`,
          yaml === undefined
            ? "config.yml is missing — blank issues stay enabled"
            : `config.yml is missing — GitHub reads only that name, not ${yaml}; blank issues stay enabled`,
          "the 'Open a blank issue' link bypasses every form",
        ),
      );
    } else if (!/^blank_issues_enabled:\s*false\b/m.test(configText)) {
      out.push(
        finding(
          `${DIR}/${config}`,
          "blank_issues_enabled is not false",
          "the 'Open a blank issue' link bypasses every form",
        ),
      );
    }
    for (const md of files.filter((f) => /\.md$/i.test(f))) {
      out.push(
        finding(
          `${DIR}/${md}`,
          `legacy Markdown template ${md} sits beside the forms`,
          "GitHub offers it next to the forms as a second, unguided entry — reporters take it",
        ),
      );
    }
    return out;
  },
};
