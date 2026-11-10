-- Existing links keep their current lifetime (NULL); new application-created links default to seven days.
ALTER TABLE `public_shares` ADD `expires_at` integer;
