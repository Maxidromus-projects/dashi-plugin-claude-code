// Ссылки, спрятанные под текстом сообщения.
//
// 04.09.2026 владелец дважды за утро присылал пересланный пост, где адрес
// стоял под словом «тут», и дважды слышал в ответ, что ссылки не видно.
// Телеграм держит такой адрес отдельным полем; сессия получала только текст.
import { describe, expect, test } from 'bun:test'
import type { Message, MessageEntity } from 'grammy/types'

import {
  HIDDEN_LINKS_LABEL,
  appendHiddenLinks,
  hiddenLinkUrls,
  newHiddenLinks,
} from '../../src/telegram/hidden-links.js'

function msg(fields: Partial<Message>): Partial<Message> {
  return fields
}

const link = (url: string, offset = 0, length = 3): MessageEntity =>
  ({ type: 'text_link', offset, length, url }) as MessageEntity

describe('hiddenLinkUrls', () => {
  test('берёт адрес из entities текстового сообщения', () => {
    const m = msg({ text: 'смотри тут', entities: [link('https://example.com/a')] })
    expect(hiddenLinkUrls(m)).toEqual(['https://example.com/a'])
  })

  test('берёт адрес из caption_entities: у фото сущности лежат отдельно', () => {
    const m = msg({ caption: 'смотри тут', caption_entities: [link('https://example.com/b')] })
    expect(hiddenLinkUrls(m)).toEqual(['https://example.com/b'])
  })

  test('прочие сущности пропускает', () => {
    const m = msg({
      text: 'жирный текст и упоминание',
      entities: [
        { type: 'bold', offset: 0, length: 6 },
        { type: 'mention', offset: 7, length: 4 },
      ] as MessageEntity[],
    })
    expect(hiddenLinkUrls(m)).toEqual([])
  })

  test('не-http адреса отбрасывает: агент их всё равно не откроет', () => {
    const m = msg({ text: 'тут', entities: [link('tg://resolve?domain=x'), link('mailto:a@b.c')] })
    expect(hiddenLinkUrls(m)).toEqual([])
  })

  test('повторы схлопывает, порядок сохраняет', () => {
    const m = msg({
      text: 'тут и там',
      entities: [link('https://a.example'), link('https://b.example'), link('https://a.example')],
    })
    expect(hiddenLinkUrls(m)).toEqual(['https://a.example', 'https://b.example'])
  })

  test('сообщения нет -- пустой список, а не падение', () => {
    expect(hiddenLinkUrls(undefined)).toEqual([])
    expect(hiddenLinkUrls(msg({}))).toEqual([])
  })
})

describe('newHiddenLinks', () => {
  test('адрес, уже написанный словами, не дублируется', () => {
    expect(newHiddenLinks('см. https://a.example', ['https://a.example'])).toEqual([])
  })

  test('подпись канала пропускается, когда есть настоящая ссылка', () => {
    expect(
      newHiddenLinks('пост', ['https://t.me/backdoor', 'https://vc.ru/ai/1']),
    ).toEqual(['https://vc.ru/ai/1'])
  })

  test('телеграмная ссылка остаётся, когда других нет: пустой список хуже', () => {
    expect(newHiddenLinks('пост', ['https://t.me/backdoor/991'])).toEqual([
      'https://t.me/backdoor/991',
    ])
  })
})

describe('appendHiddenLinks', () => {
  test('дописывает строку с адресом под текстом', () => {
    const m = msg({ text: 'Имба лежит тут', entities: [link('https://github.com/x/y')] })
    const out = appendHiddenLinks('Имба лежит тут', m)
    expect(out).toBe(`Имба лежит тут\n\n${HIDDEN_LINKS_LABEL} https://github.com/x/y`)
  })

  test('исходный текст сохраняется дословно: на него смотрят команды и упоминания', () => {
    const m = msg({ text: '/list тут', entities: [link('https://example.com/z')] })
    expect(appendHiddenLinks('/list тут', m).startsWith('/list тут')).toBe(true)
  })

  test('дописывать нечего -- текст возвращается как был', () => {
    expect(appendHiddenLinks('просто текст', msg({ text: 'просто текст' }))).toBe('просто текст')
  })

  test('пустой текст остаётся пустым: голосовое не должно стать текстовым', () => {
    const m = msg({ caption: '', caption_entities: [link('https://example.com/v')] })
    expect(appendHiddenLinks('', m)).toBe('')
  })
})
