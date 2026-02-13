import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quit", {
    description: "Exit pi (alias for /exit)",
    handler: async (_args, ctx) => {
      const exitCmd = pi.getCommands().find(c => c.name === "exit");
      if (exitCmd) {
        await exitCmd.handler("", ctx);
      } else {
        process.exit(0);
      }
    },
  });

  pi.registerCommand("q", {
    description: "Exit pi (alias for /exit)",
    handler: async (_args, ctx) => {
      const exitCmd = pi.getCommands().find(c => c.name === "exit");
      if (exitCmd) {
        await exitCmd.handler("", ctx);
      } else {
        process.exit(0);
      }
    },
  });
}
