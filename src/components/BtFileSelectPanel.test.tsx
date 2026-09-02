// BtFileSelectPanel 纯逻辑单测（vitest，不依赖 DOM）。
// 覆盖的是「只下选中文件」这条链路上最容易出错的一环：过滤后勾选集合与 only_files 数组的构造。
// 运行：npx vitest run
import { describe, it, expect } from 'vitest'
import { filterFiles, selectedBytes, toOnlyFiles, isConfirmDisabled } from './BtFileSelectPanel'
import type { BtFileEntry } from '../types'

const MB = 1024 * 1024

// 典型「夹带垃圾」的种子：大视频 + 广告 url/nfo + 字幕子目录
const files: BtFileEntry[] = [
  { index: 0, name: 'Movie.2026.1080p.mkv', components: ['Movie.2026.1080p.mkv'], length: 900 * MB },
  { index: 1, name: '【广告】最新地址.url', components: ['【广告】最新地址.url'], length: 120 },
  { index: 2, name: 'info.nfo', components: ['info.nfo'], length: 2048 },
  { index: 3, name: 'subs/chs.srt', components: ['subs', 'chs.srt'], length: 60 * 1024 },
  { index: 4, name: 'Sample/sample.mkv', components: ['Sample', 'sample.mkv'], length: 30 * MB },
]

describe('filterFiles', () => {
  it('空查询 + 无体积门槛时返回全部，且保持原始 index 顺序', () => {
    const r = filterFiles(files, '', 0)
    expect(r.map(f => f.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('按文件名子串过滤，大小写不敏感', () => {
    expect(filterFiles(files, 'MKV', 0).map(f => f.index)).toEqual([0, 4])
    expect(filterFiles(files, 'srt', 0).map(f => f.index)).toEqual([3])
    expect(filterFiles(files, '广告', 0).map(f => f.index)).toEqual([1])
    expect(filterFiles(files, '不存在的名字', 0)).toEqual([])
  })

  it('按最小体积隐藏小文件（垃圾文件正是小文件）', () => {
    expect(filterFiles(files, '', 1 * MB).map(f => f.index)).toEqual([0, 4])
    expect(filterFiles(files, '', 100 * MB).map(f => f.index)).toEqual([0])
  })

  it('搜索与体积门槛叠加生效', () => {
    expect(filterFiles(files, 'mkv', 100 * MB).map(f => f.index)).toEqual([0])
  })
})

describe('toOnlyFiles', () => {
  it('空选集 → 空数组（对应确认按钮禁用）', () => {
    expect(toOnlyFiles(new Set())).toEqual([])
    expect(toOnlyFiles(new Set()).length === 0).toBe(true)
  })

  it('全选 → 全部索引，升序', () => {
    const all = new Set(files.map(f => f.index))
    expect(toOnlyFiles(all)).toEqual([0, 1, 2, 3, 4])
  })

  it('乱序勾选也输出升序，且原样保留后端下发的 index（不重新编号）', () => {
    expect(toOnlyFiles(new Set([4, 0, 3]))).toEqual([0, 3, 4])
  })

  it('过滤后「全选可见」只包含可见项的 index', () => {
    const visible = filterFiles(files, '', 1 * MB) // index 0、4
    const picked = new Set(visible.map(f => f.index))
    expect(toOnlyFiles(picked)).toEqual([0, 4])
    // 被隐藏的垃圾文件不会进入 only_files
    expect(toOnlyFiles(picked)).not.toContain(1)
    expect(toOnlyFiles(picked)).not.toContain(2)
  })

  it('先过滤再取消勾选，得到「只要正片不要 sample」', () => {
    const picked = new Set(filterFiles(files, 'mkv', 0).map(f => f.index)) // 0、4
    picked.delete(4)
    expect(toOnlyFiles(picked)).toEqual([0])
  })
})

describe('selectedBytes', () => {
  it('累加勾选项体积；未勾选不计', () => {
    expect(selectedBytes(files, new Set())).toBe(0)
    expect(selectedBytes(files, new Set([1, 2]))).toBe(120 + 2048)
    expect(selectedBytes(files, new Set(files.map(f => f.index)))).toBe(
      900 * MB + 120 + 2048 + 60 * 1024 + 30 * MB,
    )
  })

  it('忽略不存在的 index（防御：面板 state 与清单不一致时不应崩）', () => {
    expect(selectedBytes(files, new Set([99]))).toBe(0)
  })
})

describe('isConfirmDisabled', () => {
  it('未勾选任何文件时禁用（对应确认按钮 disabled）', () => {
    expect(isConfirmDisabled(new Set())).toBe(true)
  })
  it('勾选至少一个文件时不禁用', () => {
    expect(isConfirmDisabled(new Set([0]))).toBe(false)
    expect(isConfirmDisabled(new Set([0, 3, 4]))).toBe(false)
  })
})

describe('路径渲染', () => {
  it('components.join("/") 与后端下发的 name 一致（跨平台统一用 /）', () => {
    for (const f of files) {
      expect(f.components.join('/')).toBe(f.name)
      expect(f.components.join('/')).not.toContain('\\')
    }
  })

  it('单文件种子的 components 只有一个分量', () => {
    expect(files[0].components).toHaveLength(1)
    expect(files[3].components.join('/')).toBe('subs/chs.srt')
  })
})
