function buildPluginRegistry(plugins = []) {
  const items = Array.isArray(plugins) ? plugins.filter(Boolean) : [];

  function detect(text) {
    for (const plugin of items) {
      try {
        const matched = plugin.detect?.(text);
        if (matched) return { plugin, target: matched };
      } catch (error) {
        console.log(`[plugin:${plugin?.name || 'unknown'}] detect failed:`, error?.message || error);
      }
    }
    return null;
  }

  async function process(text) {
    const matched = detect(text);
    if (!matched) return null;
    const result = await matched.plugin.process(matched.target, { text });
    return { plugin: matched.plugin, target: matched.target, result };
  }

  return {
    items,
    detect,
    process
  };
}

module.exports = { buildPluginRegistry };
