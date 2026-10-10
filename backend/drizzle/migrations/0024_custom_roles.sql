-- 0024_custom_roles: roles a business makes itself (PRD FR-USR-01, backend doc 8.33), from plan Growth on.
-- A custom role can be deleted once nobody holds it and no open invitation offers it. Invitations already
-- accepted or revoked keep their row without the role: role_id becomes NULL (the audit log keeps its name).
ALTER TABLE invitation ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE invitation DROP CONSTRAINT invitation_role_fk;
ALTER TABLE invitation ADD CONSTRAINT invitation_role_fk FOREIGN KEY (tenant_id, role_id)
  REFERENCES role (tenant_id, id) ON DELETE SET NULL (role_id);

-- One name per business whatever its case: "Gudang" and "gudang" read as the same role.
ALTER TABLE role ADD CONSTRAINT role_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 40);
CREATE UNIQUE INDEX role_tenant_lower_name_uq ON role (tenant_id, lower(name));
