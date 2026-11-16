/**
 * Engine registry.
 *
 * Each engine file exports an array of engines with the same shape:
 *
 *   {
 *     id, module, label, purpose,
 *     input,                      // description of the expected fields, served by GET /ai/tools
 *     prompt(input) -> string,    // what was asked, stored on the run
 *     run({ input, db, settings, now, helpers }) -> {
 *       output,                   // the text HR reviews
 *       sources: [{kind,id,label}],
 *       confidence: 0..1,
 *       limitation?: string,
 *       data?: object             // structured result for the UI
 *     }
 *   }
 *
 * `run` must be a pure read: engines never write to the database, which is what keeps "AI
 * cannot decide" true at the architecture level rather than by convention.
 */

const ENGINE_FILES = [
  './engines/assistant',
  './engines/policy',
  './engines/documents',
  './engines/document-ai',
  './engines/employees',
  './engines/recruitment',
  './engines/onboarding',
  './engines/attendance',
  './engines/leave',
  './engines/payroll',
  './engines/performance',
  './engines/training',
  './engines/surveys',
  './engines/reports',
  './engines/data-quality',
];

const engines = new Map();

for (const file of ENGINE_FILES) {
  for (const engine of require(file)) {
    if (engines.has(engine.id)) throw new Error(`Duplicate AI engine id: ${engine.id}`);
    if (typeof engine.run !== 'function') throw new Error(`Engine ${engine.id} has no run()`);
    engines.set(engine.id, engine);
  }
}

/** `ask-hr-policy` → `askHrPolicy`, the key used in settings.ai.features. */
function featureKey(toolId) {
  return toolId.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

function get(toolId) {
  return engines.get(toolId) || null;
}

function list() {
  return [...engines.values()].map((engine) => ({
    id: engine.id,
    module: engine.module,
    label: engine.label,
    purpose: engine.purpose,
    input: engine.input || {},
    featureKey: featureKey(engine.id),
  }));
}

module.exports = { get, list, featureKey, size: engines.size };
