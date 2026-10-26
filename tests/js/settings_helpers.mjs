/** 模拟已核实的 Comfy.Locale 设置存取与 EventTarget 事件边界。 */
export function localeSettings(initial = 'zh') {
  let locale = initial;
  const listeners = new Set();
  const settings = new EventTarget();
  const add = settings.addEventListener.bind(settings), remove = settings.removeEventListener.bind(settings);
  settings.addEventListener = (name, fn, options) => { if (name === 'Comfy.Locale.change') listeners.add(fn); add(name, fn, options); };
  settings.removeEventListener = (name, fn, options) => { if (name === 'Comfy.Locale.change') listeners.delete(fn); remove(name, fn, options); };
  settings.getSettingValue = id => id === 'Comfy.Locale' ? locale : undefined;
  settings.setLocale = value => { const oldValue = locale; locale = value; const event = new Event('Comfy.Locale.change'); event.detail = {value, oldValue}; settings.dispatchEvent(event); };
  settings.localeListenerCount = () => listeners.size;
  return settings;
}
