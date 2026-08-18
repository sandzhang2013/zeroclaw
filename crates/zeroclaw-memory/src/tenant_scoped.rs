//! Per-turn tenant isolation for memory reads and writes.
//!
//! Reads [`zeroclaw_api::TOOL_LOOP_USER_ATTRS`] on every call. Do not bake a
//! tenant id into the wrapper: one agent handle serves many BFF users.

use super::traits::{ExportFilter, Memory, MemoryCategory, MemoryEntry, StoreOptions};
use anyhow::{Result, bail};
use async_trait::async_trait;
use std::sync::Arc;
use zeroclaw_api::{UserAttrs, current_user_attrs};

pub struct TenantScopedMemory {
    inner: Arc<dyn Memory>,
}

impl TenantScopedMemory {
    #[must_use]
    pub fn new(inner: Arc<dyn Memory>) -> Self {
        Self { inner }
    }

    fn attrs(&self) -> Option<Option<UserAttrs>> {
        current_user_attrs()
    }

    fn visible(&self, entry: &MemoryEntry) -> bool {
        match self.attrs() {
            None => true,
            Some(None) => false,
            Some(Some(ref attrs)) => entry.tenant_id.as_deref() == Some(attrs.user_id.as_str()),
        }
    }

    fn stamp_options(&self, mut options: StoreOptions) -> Result<StoreOptions> {
        match self.attrs() {
            None => Ok(options),
            Some(None) => {
                bail!("memory write refused: missing frozen user identity")
            }
            Some(Some(ref attrs)) => {
                if let Some(existing) = options.tenant_id.as_deref()
                    && existing != attrs.user_id
                {
                    bail!(
                        "TenantScopedMemory refuses store for foreign tenant_id; bound user is {}",
                        attrs.user_id
                    );
                }
                options.tenant_id = Some(attrs.user_id.clone());
                Ok(options)
            }
        }
    }

    fn filter_entries(&self, entries: Vec<MemoryEntry>) -> Vec<MemoryEntry> {
        match self.attrs() {
            None => entries,
            Some(None) => Vec::new(),
            Some(Some(_)) => entries.into_iter().filter(|e| self.visible(e)).collect(),
        }
    }
}

impl ::zeroclaw_api::attribution::Attributable for TenantScopedMemory {
    fn role(&self) -> ::zeroclaw_api::attribution::Role {
        self.inner.role()
    }
    fn alias(&self) -> &str {
        self.inner.alias()
    }
}

#[async_trait]
impl Memory for TenantScopedMemory {
    fn name(&self) -> &str {
        self.inner.name()
    }

    async fn health_check(&self) -> bool {
        self.inner.health_check().await
    }

    fn refresh_embedder(
        &self,
        model_provider: &str,
        api_key: Option<&str>,
        model: &str,
        dimensions: usize,
    ) {
        self.inner
            .refresh_embedder(model_provider, api_key, model, dimensions);
    }

    async fn store(
        &self,
        key: &str,
        content: &str,
        category: MemoryCategory,
        session_id: Option<&str>,
    ) -> Result<()> {
        let options = self.stamp_options(StoreOptions::default())?;
        self.inner
            .store_with_options(key, content, category, session_id, options)
            .await
    }

    async fn store_with_metadata(
        &self,
        key: &str,
        content: &str,
        category: MemoryCategory,
        session_id: Option<&str>,
        namespace: Option<&str>,
        importance: Option<f64>,
    ) -> Result<()> {
        let options = self.stamp_options(StoreOptions {
            namespace: namespace.map(str::to_string),
            importance,
            ..Default::default()
        })?;
        self.inner
            .store_with_options(key, content, category, session_id, options)
            .await
    }

    async fn store_with_options(
        &self,
        key: &str,
        content: &str,
        category: MemoryCategory,
        session_id: Option<&str>,
        options: StoreOptions,
    ) -> Result<()> {
        let options = self.stamp_options(options)?;
        self.inner
            .store_with_options(key, content, category, session_id, options)
            .await
    }

    async fn store_with_options_and_agent(
        &self,
        key: &str,
        content: &str,
        category: MemoryCategory,
        session_id: Option<&str>,
        options: StoreOptions,
        agent_id: Option<&str>,
    ) -> Result<()> {
        let options = self.stamp_options(options)?;
        self.inner
            .store_with_options_and_agent(key, content, category, session_id, options, agent_id)
            .await
    }

    async fn store_with_agent(
        &self,
        key: &str,
        content: &str,
        category: MemoryCategory,
        session_id: Option<&str>,
        namespace: Option<&str>,
        importance: Option<f64>,
        agent_id: Option<&str>,
    ) -> Result<()> {
        let options = self.stamp_options(StoreOptions {
            namespace: namespace.map(str::to_string),
            importance,
            ..Default::default()
        })?;
        self.inner
            .store_with_options_and_agent(key, content, category, session_id, options, agent_id)
            .await
    }

    async fn recall(
        &self,
        query: &str,
        limit: usize,
        session_id: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(Vec::new());
        }
        let entries = self
            .inner
            .recall(query, limit, session_id, since, until)
            .await?;
        Ok(self.filter_entries(entries))
    }

    async fn recall_for_agents(
        &self,
        caller_allowed: &[&str],
        query: &str,
        limit: usize,
        session_id: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(Vec::new());
        }
        let entries = self
            .inner
            .recall_for_agents(caller_allowed, query, limit, session_id, since, until)
            .await?;
        Ok(self.filter_entries(entries))
    }

    async fn get(&self, key: &str) -> Result<Option<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(None);
        }
        Ok(self.inner.get(key).await?.filter(|e| self.visible(e)))
    }

    async fn get_for_agent(&self, key: &str, agent_id: &str) -> Result<Option<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(None);
        }
        Ok(self
            .inner
            .get_for_agent(key, agent_id)
            .await?
            .filter(|e| self.visible(e)))
    }

    async fn list(
        &self,
        category: Option<&MemoryCategory>,
        session_id: Option<&str>,
    ) -> Result<Vec<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(Vec::new());
        }
        let entries = self.inner.list(category, session_id).await?;
        Ok(self.filter_entries(entries))
    }

    async fn forget(&self, key: &str) -> Result<bool> {
        match self.attrs() {
            Some(None) => bail!("memory forget refused: missing frozen user identity"),
            None => self.inner.forget(key).await,
            Some(Some(_)) => match self.get(key).await? {
                Some(_) => self.inner.forget(key).await,
                None => Ok(false),
            },
        }
    }

    async fn forget_for_agent(&self, key: &str, agent_id: &str) -> Result<bool> {
        match self.attrs() {
            Some(None) => bail!("memory forget refused: missing frozen user identity"),
            None => self.inner.forget_for_agent(key, agent_id).await,
            Some(Some(_)) => match self.get_for_agent(key, agent_id).await? {
                Some(_) => self.inner.forget_for_agent(key, agent_id).await,
                None => Ok(false),
            },
        }
    }

    async fn export(&self, filter: &ExportFilter) -> Result<Vec<MemoryEntry>> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(Vec::new());
        }
        let entries = self.inner.export(filter).await?;
        Ok(self.filter_entries(entries))
    }

    async fn count(&self) -> Result<usize> {
        if matches!(self.attrs(), Some(None)) {
            return Ok(0);
        }
        Ok(self.list(None, None).await?.len())
    }

    async fn ensure_agent_uuid(&self, alias: &str) -> Result<String> {
        self.inner.ensure_agent_uuid(alias).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::SqliteMemory;
    use tempfile::TempDir;
    use zeroclaw_api::{TOOL_LOOP_USER_ATTRS, UserAttrs};

    fn fresh() -> (TempDir, TenantScopedMemory) {
        let tmp = TempDir::new().unwrap();
        let inner = Arc::new(SqliteMemory::new("test", tmp.path()).unwrap());
        (tmp, TenantScopedMemory::new(inner))
    }

    #[tokio::test]
    async fn unscoped_pass_through_does_not_stamp_tenant() {
        let (_tmp, mem) = fresh();
        mem.store("k", "plain", MemoryCategory::Core, None)
            .await
            .unwrap();
        let entry = mem.get("k").await.unwrap().unwrap();
        assert!(entry.tenant_id.is_none());
    }

    #[tokio::test]
    async fn scoped_empty_fails_closed_on_write_and_hides_reads() {
        let (_tmp, mem) = fresh();
        TOOL_LOOP_USER_ATTRS
            .scope(None, async {
                let err = mem
                    .store("k", "secret", MemoryCategory::Core, None)
                    .await
                    .unwrap_err();
                assert!(err.to_string().contains("missing frozen user identity"));
                assert!(mem.get("k").await.unwrap().is_none());
                assert!(
                    mem.recall("secret", 10, None, None, None)
                        .await
                        .unwrap()
                        .is_empty()
                );
            })
            .await;
    }

    #[tokio::test]
    async fn user_a_recall_does_not_return_user_b_memories() {
        let (_tmp, mem) = fresh();
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice")), async {
                mem.store("alice-key", "alice flu notes", MemoryCategory::Core, None)
                    .await
                    .unwrap();
            })
            .await;
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("bob")), async {
                mem.store("bob-key", "bob flu notes", MemoryCategory::Core, None)
                    .await
                    .unwrap();
                let listed = mem.list(None, None).await.unwrap();
                assert_eq!(listed.len(), 1);
                assert_eq!(listed[0].key, "bob-key");
                assert!(mem.get("alice-key").await.unwrap().is_none());
                let hits = mem.recall("flu", 10, None, None, None).await.unwrap();
                assert!(hits.iter().all(|e| e.key == "bob-key"));
            })
            .await;
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice")), async {
                let hits = mem.recall("flu", 10, None, None, None).await.unwrap();
                assert_eq!(hits.len(), 1);
                assert_eq!(hits[0].key, "alice-key");
            })
            .await;
    }

    #[tokio::test]
    async fn same_key_is_independent_per_tenant() {
        let (_tmp, mem) = fresh();
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice")), async {
                mem.store("prefs", "alice-prefs", MemoryCategory::Core, None)
                    .await
                    .unwrap();
            })
            .await;
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("bob")), async {
                mem.store("prefs", "bob-prefs", MemoryCategory::Core, None)
                    .await
                    .unwrap();
                let entry = mem.get("prefs").await.unwrap().expect("bob sees own prefs");
                assert_eq!(entry.content, "bob-prefs");
                assert_eq!(entry.tenant_id.as_deref(), Some("bob"));
            })
            .await;
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice")), async {
                let entry = mem
                    .get("prefs")
                    .await
                    .unwrap()
                    .expect("alice sees own prefs");
                assert_eq!(entry.content, "alice-prefs");
                assert!(mem.forget("prefs").await.unwrap());
                assert!(mem.get("prefs").await.unwrap().is_none());
            })
            .await;
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("bob")), async {
                let entry = mem
                    .get("prefs")
                    .await
                    .unwrap()
                    .expect("bob prefs survive alice forget");
                assert_eq!(entry.content, "bob-prefs");
            })
            .await;
    }

    #[tokio::test]
    async fn tenant_scoped_memory_rejects_foreign_writes() {
        let (_tmp, mem) = fresh();
        TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice")), async {
                let err = mem
                    .store_with_options(
                        "k",
                        "x",
                        MemoryCategory::Core,
                        None,
                        StoreOptions::default().with_tenant_id("bob"),
                    )
                    .await
                    .unwrap_err();
                assert!(err.to_string().contains("foreign tenant_id"));
            })
            .await;
    }
}
