const scenarioArg = process.argv.find((arg) => arg.startsWith("--qj-scenario="));
const scenario = scenarioArg ? scenarioArg.slice("--qj-scenario=".length) : "ok";
const TEXT = "The kettle warmed slowly while rain tapped against the window.";

if (scenario === "slow") {
  setTimeout(() => process.exit(0), 30000);
} else if (scenario === "garbage") {
  console.log("<not json>");
} else if (scenario === "crash") {
  console.error("engine exploded on purpose");
  process.exit(2);
} else {
  console.log(JSON.stringify({ text: TEXT, language: "en" }));
}
