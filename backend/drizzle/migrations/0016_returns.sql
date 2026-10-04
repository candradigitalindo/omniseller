-- 0016_returns: buyers' return, refund, and cancellation requests read from the marketplaces, the
-- seller's decisions sent back, and returned goods received into sellable stock or quarantine; parcels
-- of shipped orders that were cancelled come back as RTO (PRD FR-RET-01, 02, 03, 06, 07; backend doc 8.26).

------------------------------------------------------------------------------------------------
-- A request: one marketplace return or cancellation request, or one parcel coming back (rto)
------------------------------------------------------------------------------------------------

CREATE TABLE return_request_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE return_request (
  id                     ulid PRIMARY KEY,
  tenant_id              ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  row_version            integer NOT NULL DEFAULT 1,
  store_id               ulid NOT NULL,
  order_id               ulid NOT NULL,
  -- the order's warehouse: where the goods go back by default, and whose staff see the request
  warehouse_id           ulid,
  -- from the marketplace: return_refund, refund_only, replacement, exchange, and cancellation (the buyer
  -- asks to cancel before shipping); rto: a shipped order was cancelled and its parcel comes back
  kind                   text NOT NULL
                           CHECK (kind IN ('return_refund', 'refund_only', 'replacement', 'exchange', 'cancellation', 'rto')),
  -- Shopee return_sn, TikTok Shop return_id or cancel_id; a Shopee cancellation request: its order_sn
  external_return_id     text,
  status                 text NOT NULL
                           CHECK (status IN ('requested', 'negotiating', 'accepted', 'in_transit', 'rejected', 'disputed',
                                             'refunded', 'cancelled', 'closed')),
  status_changed_at      timestamptz NOT NULL DEFAULT now(),
  external_status        text,
  initiator              text CHECK (initiator IN ('buyer', 'seller', 'marketplace')),
  reason_code            text,
  -- the buyer's reason in words; may be the buyer's own text, never logged
  reason                 text,
  -- [{type, url, thumbnailUrl, by}]: the marketplace's URLs of the request's photos and videos
  evidence               jsonb NOT NULL DEFAULT '[]',
  refund_amount          bigint CHECK (refund_amount >= 0),
  currency               char(3) NOT NULL DEFAULT 'IDR',
  -- the marketplace decides by itself after this (FR-RET-07)
  respond_by_at          timestamptz,
  seller_action          text,
  -- the items come back to the seller's own warehouse (not for orders a marketplace warehouse fulfilled)
  goods_return           boolean NOT NULL DEFAULT false,
  return_tracking_number text,
  return_carrier         text,
  external_created_at    timestamptz,
  -- the marketplace's update time; older snapshots are ignored
  external_updated_at    timestamptz,
  -- what the seller may decide now ([{code, action, label, reasons, needsEmail}]), read by the worker for
  -- the marketplace status in decisions_for; null: not read yet
  decisions              jsonb,
  decisions_for          text,
  decisions_read_at      timestamptz,
  -- a worker job is reading them (claim, taken over after 5 minutes): two jobs never read one request
  decisions_claimed_at   timestamptz,
  -- photos the seller uploaded for a rejection: [{fileId, contentType, size, uploadedAt, uploadedBy}]
  seller_evidence        jsonb NOT NULL DEFAULT '[]',
  -- the seller's decision (the marketplace's decision code): pending while the worker sends it, then sent
  -- or failed
  decision               text,
  decision_action        text CHECK (decision_action IN ('accept', 'reject')),
  -- the marketplace status the decision answered: a later status may wait for another decision
  decided_for            text,
  response_status        text CHECK (response_status IN ('pending', 'sent', 'failed')),
  -- {label, reason, reasonLabel, comment, evidence: [{fileId, module}], email}; the email is removed once sent
  response               jsonb,
  -- each decision sent is a new marketplace request (TikTok Shop idempotency key `<id>-<attempt>`)
  response_attempt       integer NOT NULL DEFAULT 0 CHECK (response_attempt >= 0),
  response_error         text,
  decided_at             timestamptz,
  decided_by             ulid,
  -- the returned goods were received (FR-RET-03); the quantities are on return_item
  received_at            timestamptz,
  received_by            ulid,
  received_warehouse_id  ulid,
  receipt_note           text,
  -- notifications: new request not announced yet; alert sent for the current deadline (FR-RET-07)
  notify_new             boolean NOT NULL DEFAULT false,
  due_alerted_at         timestamptz,
  CONSTRAINT return_request_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT return_request_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT return_request_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT return_request_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (warehouse_id),
  CONSTRAINT return_request_decided_by_fk FOREIGN KEY (tenant_id, decided_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (decided_by),
  CONSTRAINT return_request_received_by_fk FOREIGN KEY (tenant_id, received_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (received_by),
  CONSTRAINT return_request_received_warehouse_fk FOREIGN KEY (tenant_id, received_warehouse_id)
    REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (received_warehouse_id),
  CONSTRAINT return_request_external_ck CHECK ((kind = 'rto') = (external_return_id IS NULL)),
  CONSTRAINT return_request_response_ck CHECK (
    (response_status IS NULL) = (response IS NULL) AND (response IS NULL) = (decision IS NULL)
    AND (decision IS NULL) = (decision_action IS NULL)),
  CONSTRAINT return_request_receipt_ck CHECK (
    received_at IS NOT NULL OR (received_by IS NULL AND received_warehouse_id IS NULL AND receipt_note IS NULL)),
  CONSTRAINT return_request_cancellation_ck CHECK (kind <> 'cancellation' OR (NOT goods_return AND received_at IS NULL))
);
CREATE INDEX return_request_tenant_id_idx ON return_request (tenant_id, id DESC);
CREATE INDEX return_request_tenant_order_idx ON return_request (tenant_id, order_id);
-- a TikTok Shop cancel_id and return_id never meet; a Shopee cancellation is keyed by its order_sn
CREATE UNIQUE INDEX return_request_external_uq
  ON return_request (tenant_id, store_id, (kind = 'cancellation'), external_return_id)
  WHERE external_return_id IS NOT NULL;
-- an order is cancelled once: one parcel to wait for
CREATE UNIQUE INDEX return_request_rto_uq ON return_request (tenant_id, order_id) WHERE kind = 'rto';
-- the scheduler's scans: deadlines coming (FR-RET-07) and new requests to announce
CREATE INDEX return_request_due_idx ON return_request (respond_by_at)
  WHERE due_alerted_at IS NULL AND respond_by_at IS NOT NULL;
CREATE INDEX return_request_notify_idx ON return_request (tenant_id) WHERE notify_new;
-- the warehouse's list of parcels to receive
CREATE INDEX return_request_to_receive_idx ON return_request (tenant_id, id DESC) WHERE goods_return AND received_at IS NULL;

------------------------------------------------------------------------------------------------
-- Items: units of one order line in a request, and what came back of them
------------------------------------------------------------------------------------------------

CREATE TABLE return_item (
  id                  ulid PRIMARY KEY,
  tenant_id           ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  return_request_id   ulid NOT NULL,
  -- the order line the units come from; null when the order has no line for the marketplace's item
  order_item_id       ulid,
  -- the marketplace's listing item and variant, as the request names them
  external_item_id    text NOT NULL DEFAULT '',
  external_variant_id text NOT NULL DEFAULT '',
  sku                 text,
  title               text,
  qty                 integer NOT NULL CHECK (qty > 0),
  refund_amount       bigint CHECK (refund_amount >= 0),
  -- receipt (FR-RET-03): back in sellable stock, into quarantine (damaged), and not received
  sellable_qty        integer CHECK (sellable_qty >= 0),
  damaged_qty         integer CHECK (damaged_qty >= 0),
  missing_qty         integer CHECK (missing_qty >= 0),
  received_at         timestamptz,
  CONSTRAINT return_item_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT return_item_request_fk FOREIGN KEY (tenant_id, return_request_id)
    REFERENCES return_request (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT return_item_order_item_fk FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES order_item (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT return_item_receipt_ck CHECK (
    (received_at IS NULL AND sellable_qty IS NULL AND damaged_qty IS NULL AND missing_qty IS NULL)
    OR (received_at IS NOT NULL AND sellable_qty + damaged_qty + missing_qty = qty))
);
CREATE INDEX return_item_request_idx ON return_item (tenant_id, return_request_id);
CREATE INDEX return_item_order_item_idx ON return_item (tenant_id, order_item_id);
CREATE UNIQUE INDEX return_item_line_uq ON return_item (return_request_id, order_item_id) WHERE order_item_id IS NOT NULL;
