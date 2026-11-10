-- Credit history is append-only. Corrections must be compensating entries;
-- account-data deletion intentionally retains this reconciliation record.
CREATE TRIGGER wallet_events_no_update
BEFORE UPDATE ON wallet_events
BEGIN
  SELECT RAISE(ABORT, 'WALLET_LEDGER_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER wallet_events_no_delete
BEFORE DELETE ON wallet_events
BEGIN
  SELECT RAISE(ABORT, 'WALLET_LEDGER_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER wallet_events_valid_amount
BEFORE INSERT ON wallet_events
WHEN typeof(NEW.amount) != 'integer'
  OR NEW.amount < -9007199254740991 OR NEW.amount > 9007199254740991
  OR NEW.mode NOT IN ('live','test')
  OR (NEW.kind IN ('topup','refund_release') AND NEW.amount <= 0)
  OR (NEW.kind IN ('reserve','refund','refund_reserve') AND NEW.amount >= 0)
  OR (NEW.kind = 'settle' AND NEW.amount < 0)
BEGIN
  SELECT RAISE(ABORT, 'WALLET_AMOUNT_INVALID');
END;
--> statement-breakpoint
-- Enforce the same safe-integer limit for the aggregate, not only each row.
-- Skip a duplicate reference: its ON CONFLICT DO NOTHING inserts no new amount.
CREATE TRIGGER wallet_events_safe_balance
BEFORE INSERT ON wallet_events
WHEN NOT EXISTS (SELECT 1 FROM wallet_events WHERE reference=NEW.reference)
  AND (SELECT COALESCE(SUM(amount),0) FROM wallet_events WHERE user_id=NEW.user_id AND mode=NEW.mode)
    NOT BETWEEN (-9007199254740991-NEW.amount) AND (9007199254740991-NEW.amount)
BEGIN
  SELECT RAISE(ABORT, 'WALLET_BALANCE_INVALID');
END;
