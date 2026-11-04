/** Explicit native model memory policy; never changes model weights or the voice reference. */
export function nativeSessionOptions(config) {
  const cpu = config.cpuExpertLayers ?? 4;
  if (!Number.isInteger(cpu) || cpu < 0) throw Error('Invalid cpuExpertLayers');
  const result = {'fish_drama3.cpu_expert_layers':cpu,'fish_drama3.context_length':2048};
  if (config.diskExperts !== undefined && typeof config.diskExperts !== 'boolean') throw Error('Invalid diskExperts');
  if (config.pinExperts !== undefined && typeof config.pinExperts !== 'boolean') throw Error('Invalid pinExperts');
  if (config.expertCacheSize !== undefined && (!Number.isInteger(config.expertCacheSize) || config.expertCacheSize < 8 || config.expertCacheSize > 256))
    throw Error('expertCacheSize must be 8–256 native cache slots per layer');
  if ((config.expertCacheSize !== undefined || config.pinExperts === true) && config.diskExperts !== true)
    throw Error('Expert cache and pinned host experts require diskExperts');
  if (config.diskExperts === true) {
    result['fish_drama3.disk_experts'] = true;
    result['fish_drama3.expert_cache_size'] = config.expertCacheSize ?? 32;
    result['fish_drama3.pin_experts'] = config.pinExperts === true;
  }
  return result;
}
