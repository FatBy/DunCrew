import type { HouseConfig } from '@/types'
import { Home, Brain, ScrollText, ListTodo, Ghost, Settings, Radio, Library } from 'lucide-react'
import { SkillHouse } from '@/components/houses/SkillHouse'
import { MemoryHouse } from '@/components/houses/MemoryHouse'
import { TaskHouse } from '@/components/houses/TaskHouse'
import { SoulHouse } from '@/components/houses/SoulHouse'
import { SettingsHouse } from '@/components/houses/SettingsHouse'
import { LinkStationHouse } from '@/components/houses/LinkStationHouse'
import { LibraryHouse } from '@/components/houses/LibraryHouse'

// World view is handled separately as the background layer.
// This placeholder is registered so the Dock can render a "Home" icon.
function WorldPlaceholder() {
  return null
}

export const houseRegistry: HouseConfig[] = [
  {
    id: 'world',
    name: '世界',
    icon: Home,
    component: WorldPlaceholder,
    themeColor: 'slate',
    description: '2.5D 游戏地图背景',
  },
  {
    id: 'task',
    name: '任务监控',
    icon: ListTodo,
    component: TaskHouse,
    themeColor: 'amber',
    description: '会话任务看板 (映射自 Sessions)',
  },
  {
    id: 'skill',
    name: '技能树',
    icon: Brain,
    component: SkillHouse,
    themeColor: 'cyan',
    description: '频道技能网络 (映射自 Channels)',
  },
  {
    id: 'memory',
    name: '记忆宫殿',
    icon: ScrollText,
    component: MemoryHouse,
    themeColor: 'emerald',
    description: '对话记忆存储 (映射自 Session History)',
  },
  {
    id: 'soul',
    name: '灵魂塔',
    icon: Ghost,
    component: SoulHouse,
    themeColor: 'purple',
    description: 'Agent 灵魂状态 (映射自 Health/Presence)',
  },
  {
    id: 'link-station',
    name: '联络站',
    icon: Radio,
    component: LinkStationHouse,
    themeColor: 'emerald',
    description: '模型通道与 MCP 连接节点管理',
  },
  {
    id: 'library',
    name: '知识库',
    icon: Library,
    component: LibraryHouse,
    themeColor: 'sky',
    description: '文件知识图谱摄入管线',
  },
  {
    id: 'settings',
    name: '系统设置',
    icon: Settings,
    component: SettingsHouse,
    themeColor: 'slate',
    description: '系统偏好设置',
  },
]

export function getHouseById(id: string): HouseConfig | undefined {
  return houseRegistry.find((h) => h.id === id)
}
