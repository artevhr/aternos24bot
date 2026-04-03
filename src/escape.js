// Экранирование для Telegram Markdown (не MarkdownV2)
// В обычном Markdown опасны: _ * ` [
// Для пользовательских данных используем code-блоки (backticks) — они безопасны
// Для обычного текста просто экранируем _ и *

function esc(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

// Оборачивает в inline-code (безопасно для любых строк кроме содержащих backtick)
function code(str) {
  if (!str && str !== 0) return '``';
  const s = String(str).replace(/`/g, "'"); // заменяем backtick на апостроф
  return `\`${s}\``;
}

module.exports = { esc, code };
