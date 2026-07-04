const fs = require("fs");
const path = require("path");

const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "Blackjack.sol", "Blackjack.json");
const targetPath = path.join(__dirname, "..", "..", "frontend", "src", "lib", "blackjackAbi.ts");

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const output = `// Auto-generated from backend artifacts — run: npm run sync-abi\nexport const blackjackAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;

fs.writeFileSync(targetPath, output);
console.log("Synced ABI to", targetPath);