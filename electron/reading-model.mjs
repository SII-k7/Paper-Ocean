export const READING_MODEL = "gpt-5.6-luna";
export const READING_EFFORT = "max";
export function fixedReadingSelection(models) {
  return models.some(model => model.id === READING_MODEL && model.supportedEfforts.includes(READING_EFFORT))
    ? { model: READING_MODEL, effort: READING_EFFORT } : null;
}
