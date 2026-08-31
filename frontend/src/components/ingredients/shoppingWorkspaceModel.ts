import type {
  ShoppingCardFocus,
  ShoppingCardViewModel,
  ShoppingOverviewViewModel,
} from './workspaceTypes';

export function buildShoppingOverview(cards: ShoppingCardViewModel[]): ShoppingOverviewViewModel[] {
  const attentionCount = cards.filter((card) => card.hasAttention).length;
  const linkedCount = cards.filter((card) => card.isLinked).length;
  const freeformCount = cards.filter((card) => !card.isLinked).length;

  return [
    {
      key: 'all',
      label: '全部待买',
      count: cards.length,
      tone:
        cards.length === 0 ? 'muted' : attentionCount > 0 ? 'warning' : linkedCount > 0 ? 'linked' : 'freeform',
      detail:
        cards.length === 0
          ? '当前采购清单为空'
          : attentionCount > 0
            ? `${attentionCount} 项需要优先购买`
            : '当前没有需要优先购买的内容',
    },
    {
      key: 'attention',
      label: '优先购买',
      count: attentionCount,
      tone: attentionCount > 0 ? 'warning' : 'muted',
      detail: attentionCount > 0 ? '关联食材有库存提醒' : '当前没有需要优先购买的内容',
    },
    {
      key: 'linked',
      label: '关联食材',
      count: linkedCount,
      tone: linkedCount > 0 ? 'linked' : 'muted',
      detail: linkedCount > 0 ? '可直接看到库存与提醒' : '当前没有关联食材的待买内容',
    },
    {
      key: 'freeform',
      label: '其他采购',
      count: freeformCount,
      tone: freeformCount > 0 ? 'freeform' : 'muted',
      detail: freeformCount > 0 ? '其他采购或还没有加入食材库的内容' : '当前没有其他采购',
    },
  ];
}

export function filterShoppingCards(
  cards: ShoppingCardViewModel[],
  term: string,
  focus: ShoppingCardFocus = 'all',
) {
  const normalized = term.trim();

  return cards.filter((card) => {
    const matchesFocus =
      focus === 'all' ||
      (focus === 'attention' && card.hasAttention) ||
      (focus === 'linked' && card.isLinked) ||
      (focus === 'freeform' && !card.isLinked);
    if (!matchesFocus) return false;
    if (!normalized) return true;
    return card.searchText.includes(normalized);
  });
}
