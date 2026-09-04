// Ссылки, спрятанные под текстом сообщения.
//
// Телеграм не пишет такую ссылку в текст: пост «Имба для ваших задач лежит --
// тут» приходит с обычным словом «тут», а сам адрес лежит отдельным полем
// (entity типа `text_link`). Сессия получает `text ?? caption`, поэтому адрес
// до агента не доезжал вовсе: на вопрос «посмотри, что по ссылке» он честно
// отвечал, что ссылки не видит, и владельцу приходилось присылать её вручную.
// Так и случилось 04.09.2026, дважды за одно утро.
//
// Мы не подменяем текст, а дописываем к нему отдельную строку с адресами.
// Подмена ломала бы всё, что считает текст дословным: и разбор команд, и
// проверку на упоминание бота, и запись расшифровок.
import type { Message, MessageEntity } from 'grammy/types'

/** Домены самого телеграма: подпись канала, ссылки на соседние каналы. */
const NAVIGATION_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog'])

/** Строка, которой начинается дописанный блок. Вынесена для тестов. */
export const HIDDEN_LINKS_LABEL = 'Скрытые ссылки в сообщении:'

function isNavigation(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return NAVIGATION_HOSTS.has(host)
  } catch {
    // Невалидный адрес -- не навигация, но и не ссылка; отсеется ниже.
    return false
  }
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * Адреса из `text_link`-сущностей сообщения, в порядке появления.
 *
 * Берём оба поля: у текстового сообщения сущности лежат в `entities`, у
 * фото и видео с подписью -- в `caption_entities`. Раньше мы смотрели только
 * на текст, и второй случай терялся полностью.
 *
 * Не-http адреса (`tg://`, `mailto:`) отбрасываем: открыть их агент всё равно
 * не может, а в строке они выглядят как рабочая ссылка.
 */
export function hiddenLinkUrls(msg: Partial<Message> | undefined): string[] {
  if (msg === undefined) return []
  const entities: MessageEntity[] = [
    ...(msg.entities ?? []),
    ...(msg.caption_entities ?? []),
  ]
  const urls: string[] = []
  for (const entity of entities) {
    if (entity.type !== 'text_link') continue
    const url = (entity as MessageEntity.TextLinkMessageEntity).url?.trim()
    if (url === undefined || url === '' || !isHttp(url)) continue
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * Ссылки, которых нет в самом тексте.
 *
 * Когда адрес написан словами и он же стоит сущностью (телеграм так делает с
 * автоссылками), дописывать нечего -- агент его и так видит.
 *
 * Навигационные ссылки телеграма опускаются, пока есть хоть одна другая:
 * подпись канала стоит под каждым пересланным постом и материалом не является.
 * Если других нет -- отдаём и её: пустой список хуже.
 */
export function newHiddenLinks(text: string, urls: string[]): string[] {
  const unseen = urls.filter((url) => !text.includes(url))
  const meaningful = unseen.filter((url) => !isNavigation(url))
  return meaningful.length > 0 ? meaningful : unseen
}

/**
 * Дописать к тексту строку со спрятанными ссылками.
 *
 * Возвращает исходный текст без изменений, когда дописывать нечего -- в том
 * числе для сообщения без текста вовсе: строка из одних ссылок превратила бы
 * голосовое или фото в «текстовое» сообщение для всех, кто ниже по потоку.
 */
export function appendHiddenLinks(text: string, msg: Partial<Message> | undefined): string {
  if (text.trim() === '') return text
  const links = newHiddenLinks(text, hiddenLinkUrls(msg))
  if (links.length === 0) return text
  return `${text}\n\n${HIDDEN_LINKS_LABEL} ${links.join(' ')}`
}
