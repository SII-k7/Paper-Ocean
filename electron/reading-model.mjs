export const READING_MODEL = "gpt-5.6-luna";
export const READING_EFFORT = "max";
export function fixedReadingSelection(models) {
  const model = models.find(model => model.id === READING_MODEL && model.supportedEfforts.includes(READING_EFFORT));
  if (!model) return null;
  const fast = model.serviceTiers?.find(tier => /^fast$/i.test(tier.name));
  return { model: READING_MODEL, effort: READING_EFFORT, ...(fast ? { serviceTier: fast.id } : {}) };
}
