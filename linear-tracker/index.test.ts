import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAssociationFromText, resolveTracker } from "./index";

const wzrrdPolicy = `# project notes

## Linear issue tracking

This project uses Linear for issues and grooming.

- Linear org: \`wzrrd\`
- Team key: \`WZR\`
- Team name: \`Wzrrd\`
- Team ID: \`60807353-5072-4cb9-9430-ae76d068dce9\`
- Secret: \`wzrrd::linear_api_key\`

## Secret routing

- \`wzrrd::cloudflare_account_id\`
`;

describe("linear tracker policy parsing", () => {
	test("reads plain Team key/Team ID labels from a Linear section", () => {
		expect(parseAssociationFromText(wzrrdPolicy)).toEqual({
			workspace: "wzrrd",
			teamKey: "WZR",
			teamId: "60807353-5072-4cb9-9430-ae76d068dce9",
		});
	});

	test("resolver accepts .pi/APPEND_SYSTEM.md association without touching secrets", () => {
		const root = mkdtempSync(join(tmpdir(), "linear-tracker-test-"));
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), wzrrdPolicy);

		const result = resolveTracker(root, { includeEvidence: true, allowAgentSecrets: false });

		expect(result.tracker).toBe("linear");
		expect(result.linearAllowed).toBe(true);
		expect(result.association.teamKey).toBe("WZR");
		expect(result.association.teamId).toBe("60807353-5072-4cb9-9430-ae76d068dce9");
		expect(result.publishMode).toBe("payload_only");
		expect(result.reasons).not.toContain("Linear policy exists, but no local Linear teamKey/teamId association was found.");
	});
});
