/** Mix standard VRM expression channels without erasing explicit controls. */
export function expressionWeights({
  available,
  expression,
  strength,
  singing,
  speechPlaying,
  mouth,
  blink,
  automatic = {},
}) {
  const weights = Object.fromEntries(available.map((name) => [name, 0]));
  if (expression && expression in weights) weights[expression] = strength;
  else {
    for (const [name, value] of Object.entries(automatic))
      if (name in weights) weights[name] = Math.max(0, Math.min(1, value));
    if (
      singing &&
      "happy" in weights &&
      !Object.values(automatic).some((v) => v > 0.01)
    )
      weights.happy = 0.2;
  }
  if ((speechPlaying || singing) && "aa" in weights)
    weights.aa = Math.max(0, Math.min(1, mouth));
  // Explicit eye controls own their eye channels for the duration of the cue.
  if (
    ![
      "blink",
      "blinkLeft",
      "blinkRight",
      "eyeBlinkLeft",
      "eyeBlinkRight",
    ].includes(expression) &&
    "blink" in weights
  )
    weights.blink = blink;
  return weights;
}
