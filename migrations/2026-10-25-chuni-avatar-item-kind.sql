-- Avatar accessories unlocked through the website were stored as itemKind 1 (nameplate)
-- instead of itemKind 11 (avatar accessory), so the game never saw them.
-- Copies each of those rows to itemKind 11. Avatar ids (>= 1100001) never overlap nameplate
-- ids, so the match is unambiguous. Original rows are left in place; safe to run more than once.
INSERT IGNORE INTO chuni_item_item (user, itemId, itemKind, stock, isValid)
SELECT i.user, i.itemId, 11, i.stock, i.isValid
FROM chuni_item_item i
WHERE i.itemKind = 1
	AND i.itemId IN (SELECT avatarAccessoryId FROM chuni_static_avatar);
