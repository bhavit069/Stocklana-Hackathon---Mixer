
ALTER TABLE limit_orders DROP CONSTRAINT IF EXISTS check_status;
ALTER TABLE limit_orders DROP CONSTRAINT IF EXISTS limit_orders_status_check;

ALTER TABLE limit_orders ADD CONSTRAINT limit_orders_status_check
    CHECK (status IN ('open', 'filling', 'filled', 'cancelled', 'failed'));
