/**
 * 收藏页（PLAN 2.4）：多源时顶上一排音源 tab（SourceTabs），一次只看一个音源，
 * 选中的音源记在 ?src=<serverId>；单源行为与原版一致。
 * 版式：大标题 + 体量说明 + 播放全部（青柠）；音源 tab 与「歌曲 / 专辑」同一行、滚动时吸顶；专辑是封面网格。
 *
 * 以前多源是一节接一节往下排，网易云收藏几百首，要划很久才看得到 QQ 那一节。
 */

import { useState } from 'react'
import { Play } from '@phosphor-icons/react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { SPRING_SNAPPY } from '@/lib/motion'
import { useStarred } from '@/hooks/useServerQueries'
import { useSourceStarred } from '@/hooks/useSourceQueries'
import { playAllInOrder } from '@/utils/playActions'
import { SongList } from '@/components/music/SongList'
import { AlbumCard } from '@/components/music/AlbumCard'
import { useQueryClient } from '@tanstack/react-query'
import { SourceTabPanel, SourceTabs, TabDock, defaultTabId, shortSourceName } from '@/components/sources/SourceTabs'
import { SourceGroupState } from '@/components/sources/SourceGroupState'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { SongRowsSkeleton } from '@/components/common/SongRowsSkeleton'
import { CoverGrid } from '@/components/common/CoverCard'
import { useT } from '@/i18n'
import { sourceParam } from '@/lib/sourceParam'

type FavTab = 'songs' | 'albums'

/**
 * 分段控件的一格：看起来 36px，触点用 ::before 向上下各多出 4px（落在轨道的内边距里），凑足 44px。
 */
const SEG_OPTION =
  'press-pop relative isolate inline-flex h-9 flex-none items-center gap-2 whitespace-nowrap rounded-pill px-4 text-[14px] font-semibold before:absolute before:inset-x-0 before:-inset-y-1'

/** 当前格底下托起的那块片。暗色下 surface 与轨道（ink 6%）几乎同亮（对比 1.03:1），改用 fill-2 才托得起来 */
const SEG_PILL = 'absolute inset-0 -z-10 rounded-pill seg-pill'

export default function Favorites() {
  const { t } = useT()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<FavTab>('songs')
  const [searchParams, setSearchParams] = useSearchParams()
  const srcFilter = sourceParam(searchParams)


  // 单源 / ?src= 过滤：一条查询；多源：每源一条（失败塌缩成该节错误行）。
  // 多源时单源 hook 关掉，避免设了曲库范围后主库同一请求打两遍
  /*
   * 保留加载中的分组。
   *
   * 丢掉它们的后果是：慢源返回的那一刻，一整节凭空插进页面中部，
   * 正在看的内容被顶下去；而且「这个源在转」和「这个源坏了」长得一模一样。
   * 三态各自呈现，位置从一开始就占住。
   */
  const starredGroups = useSourceStarred()
  /* 能收藏的音源不止一个才出 tab；只有一个时就是原来的单源页 */
  const tabbed = starredGroups.length > 1
  const single = useStarred(srcFilter, { enabled: !tabbed })
  const singleSongs = single.data?.songs ?? []
  const singleAlbums = single.data?.albums ?? []

  /* 选中的音源：地址栏 ?src= 指着的那个；没指或者指的源不在了，落到第一个 */
  const sourceTabItems = starredGroups.map(g => ({
    id: g.serverId,
    label: shortSourceName(g.name),
    pluginId: g.pluginId,
    loading: g.status !== 'success',
    count: tab === 'songs' ? g.data?.songs.length : g.data?.albums.length,
  }))
  const selectedId = tabbed ? defaultTabId(sourceTabItems, srcFilter) : (srcFilter ?? '')
  const selectSource = (id: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('src', id)
      return next
    }, { replace: true })
  }

  const selectedGroup = tabbed ? starredGroups.find(g => g.serverId === selectedId) : undefined
  const section = selectedGroup
    ? {
        serverId: selectedGroup.serverId,
        status: selectedGroup.status,
        songs: selectedGroup.data?.songs ?? [],
        albums: selectedGroup.data?.albums ?? [],
      }
    : {
        serverId: srcFilter ?? '',
        status: single.isError ? 'error' as const : single.isLoading ? 'loading' as const : 'success' as const,
        songs: singleSongs,
        albums: singleAlbums,
      }

  if (!tabbed && single.isLoading) {
    return (
      <div className="pt-2 regular:pt-4" aria-hidden="true">
        <div className="skeleton h-9 w-60 rounded-md regular:h-11" />
        <div className="skeleton mt-4 h-4 w-40 rounded-pill" />
        <div className="mt-10">
          <SongRowsSkeleton rows={8} />
        </div>
      </div>
    )
  }

  const allSongs = section.songs
  const allAlbums = section.albums

  const tabs: { key: FavTab; label: string; count: number }[] = [
    { key: 'songs', label: t('library.songs'), count: allSongs.length },
    { key: 'albums', label: t('library.albums'), count: allAlbums.length },
  ]

  return (
    <div className="pt-2 regular:pt-4">
      {/* 页头：大标题 + 体量说明（各自独立的 span）+ 青柠主操作 */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-ink regular:text-[44px]">
            {t('library.favoritesTitle')}
          </h1>
          <p className="num mt-3 flex flex-wrap gap-x-3 text-[14px] font-medium text-ink-3">
            <span>{t('library.songsCount', { count: allSongs.length })}</span>
            <span>{t('library.albumsCount', { count: allAlbums.length })}</span>
          </p>
        </div>
        {allSongs.length > 0 && (
          <Button className="flex-shrink-0" onClick={() => playAllInOrder(allSongs, 0)}>
            <Play size={18} weight="fill" />
            {t('player.playAll')}
          </Button>
        )}
      </header>

      {/*
        控件行：左边音源 tab（多源时），右边歌曲 / 专辑。整行滚动时吸在工具栏下面，
        长列表划到一半也能直接换音源。两组各自是一块半透明毛玻璃，压在列表上也读得清。
      */}
      <TabDock className="mt-6 flex flex-wrap items-center gap-3">
        {tabbed && (
          <SourceTabs
            layoutId="favorites-source-tabs"
            value={selectedId}
            onChange={selectSource}
            items={sourceTabItems}
          />
        )}
        <div className="inline-flex max-w-full overflow-x-auto rounded-pill bg-surface/85 p-1 shadow-sm ring-1 ring-ink/[0.06] backdrop-blur-xl scrollbar-hide">
          {tabs.map(item => {
            const active = tab === item.key
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                aria-pressed={active}
                className={cn(SEG_OPTION, active ? 'text-ink' : 'text-ink-3 hover:text-ink-2')}
              >
                {active && (
                  <motion.span
                    layoutId="favorites-tabs"
                    transition={SPRING_SNAPPY}
                    aria-hidden="true"
                    className={SEG_PILL}
                  />
                )}
                {item.label}
                <span className="num text-[13px] text-ink-3">{item.count}</span>
              </button>
            )
          })}
        </div>
      </TabDock>

      <div className="mt-6">
        <SourceTabPanel tabKey={`${section.serverId}:${tab}`}>
          <section className="mb-10">
            {section.status !== 'success' && (
              <SourceGroupState
                serverId={section.serverId}
                status={section.status}
                onRetry={() =>
                  queryClient.invalidateQueries({
                    predicate: query => query.queryKey[1] === 'starred',
                  })
                }
              />
            )}
            {section.status === 'success' && tab === 'songs' && (
              section.songs.length === 0 ? (
                <EmptyState
                  ruled
                  title={t('empty.favoriteSongs.title')}
                  description={t('empty.favoriteSongs.description')}
                />
              ) : (
                <SongList songs={section.songs} showAlbum />
              )
            )}
            {section.status === 'success' && tab === 'albums' && (
              section.albums.length === 0 ? (
                <EmptyState
                  ruled
                  title={t('empty.favoriteAlbums.title')}
                  description={t('empty.favoriteAlbums.description')}
                />
              ) : (
                <CoverGrid>
                  {section.albums.map(album => (
                    <AlbumCard key={`${section.serverId}:${album.id}`} album={album} />
                  ))}
                </CoverGrid>
              )
            )}
          </section>
        </SourceTabPanel>
      </div>
    </div>
  )
}
