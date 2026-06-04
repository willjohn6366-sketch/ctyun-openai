// 模型列表缓存模块
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

let cachedModels = null;
let cacheExpiry = 0;

export function getCachedModels() {
  if (cachedModels && Date.now() < cacheExpiry) {
    return cachedModels;
  }
  return null;
}

export function setCachedModels(models) {
  cachedModels = models;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
}

export function clearModelsCache() {
  cachedModels = null;
  cacheExpiry = 0;
}
