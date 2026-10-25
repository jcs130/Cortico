/** Generic admission check for speech grounded in a live observation. */
export function checkSpeechFreshness(args: Record<string, unknown>, maxAgeSeconds = 0, now = Date.now()/1000) {
  if (args.action !== 'speak') return;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) throw Error('Invalid speech observation age policy');
  if (!maxAgeSeconds && args.observed_at === undefined) return;
  const at = args.observed_at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at > now+1 || now-at > (maxAgeSeconds || 15))
    throw Error('stale_speech_observation: speech was not submitted. Use captured_at/sample time from a fresh observation, update the statement, and do not invent a timestamp.');
}

/** Advertise the configured admission rule before a model submits a speech call. */
export function speechObservationContract(maxAgeSeconds=0) {
  if(!Number.isFinite(maxAgeSeconds)||maxAgeSeconds<=0)return {};
  return {anyOf:[
    {properties:{action:{enum:['speak']}},required:['observed_at','text']},
    {properties:{action:{enum:['status','interrupt','select']}}},
  ]};
}
