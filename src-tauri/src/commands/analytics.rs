use std::fs;
use std::path::{Path, PathBuf};

use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTradeRecord {
    pub date: String,
    pub time: Option<String>,
    pub code: String,
    pub name: String,
    pub direction: String,
    pub quantity: f64,
    pub price: f64,
    pub amount: f64,
    pub fee: f64,
    pub stamp_tax: f64,
    pub transfer_fee: f64,
    pub mode_tag: Option<String>,
    pub certainty_tag: Option<String>,
    pub planned_trade: Option<bool>,
    pub health_score: Option<f64>,
    pub error_tag: Option<String>,
    pub error_cost: Option<f64>,
    pub agent_source: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTagStat {
    pub tag: String,
    pub trade_count: i64,
    pub buy_amount: f64,
    pub sell_amount: f64,
    pub fee: f64,
    pub error_cost: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSummary {
    pub source: String,
    pub database_path: String,
    pub trade_count: i64,
    pub trading_day_count: i64,
    pub total_buy_amount: f64,
    pub total_sell_amount: f64,
    pub total_fee: f64,
    pub total_error_cost: f64,
    pub turnover_amount: f64,
    pub latest_trade_date: Option<String>,
    pub mode_stats: Vec<AnalyticsTagStat>,
    pub certainty_stats: Vec<AnalyticsTagStat>,
    pub planned_stats: Vec<AnalyticsTagStat>,
    pub error_stats: Vec<AnalyticsTagStat>,
    pub agent_stats: Vec<AnalyticsTagStat>,
    pub average_health_score: Option<f64>,
}

#[tauri::command]
pub fn analytics_refresh(
    project_path: String,
    database_path: String,
    records: Vec<AnalyticsTradeRecord>,
) -> Result<AnalyticsSummary, String> {
    let db_path = resolve_database_path(&project_path, &database_path)?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create analytics directory: {}", e))?;
    }

    let mut conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open DuckDB '{}': {}", db_path.display(), e))?;
    init_schema(&conn)?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start DuckDB transaction: {}", e))?;
    tx.execute("DELETE FROM trades", params![])
        .map_err(|e| format!("Failed to clear trade table: {}", e))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO trades (
                    date, time, code, name, direction, quantity, price, amount,
                    fee, stamp_tax, transfer_fee, mode_tag, certainty_tag, planned_trade,
                    health_score, error_tag, error_cost, agent_source, note
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .map_err(|e| format!("Failed to prepare trade insert: {}", e))?;

        for record in records {
            stmt.execute(params![
                record.date,
                record.time,
                record.code,
                record.name,
                record.direction,
                record.quantity,
                record.price,
                record.amount,
                record.fee,
                record.stamp_tax,
                record.transfer_fee,
                clean_optional_tag(record.mode_tag),
                clean_optional_tag(record.certainty_tag),
                record.planned_trade,
                record.health_score,
                clean_optional_tag(record.error_tag),
                record.error_cost,
                clean_optional_tag(record.agent_source),
                clean_optional_tag(record.note),
            ])
            .map_err(|e| format!("Failed to insert trade record: {}", e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit DuckDB transaction: {}", e))?;
    query_summary(&conn, db_path)
}

fn resolve_database_path(project_path: &str, database_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() {
        return Err(format!("Project path does not exist: '{}'", project_path));
    }

    let requested = Path::new(database_path);
    let resolved = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        project.join(requested)
    };
    Ok(resolved)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS trades (
            date TEXT NOT NULL,
            time TEXT,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            direction TEXT NOT NULL,
            quantity DOUBLE NOT NULL,
            price DOUBLE NOT NULL,
            amount DOUBLE NOT NULL,
            fee DOUBLE NOT NULL,
            stamp_tax DOUBLE NOT NULL,
            transfer_fee DOUBLE NOT NULL,
            mode_tag TEXT,
            certainty_tag TEXT,
            planned_trade BOOLEAN,
            health_score DOUBLE,
            error_tag TEXT,
            error_cost DOUBLE,
            agent_source TEXT,
            note TEXT
        );

        ALTER TABLE trades ADD COLUMN IF NOT EXISTS certainty_tag TEXT;
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS planned_trade BOOLEAN;
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS health_score DOUBLE;
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS note TEXT;
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS error_cost DOUBLE;

        CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
        CREATE INDEX IF NOT EXISTS idx_trades_code ON trades(code);
        CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode_tag);
        CREATE INDEX IF NOT EXISTS idx_trades_certainty ON trades(certainty_tag);
        CREATE INDEX IF NOT EXISTS idx_trades_planned ON trades(planned_trade);
        CREATE INDEX IF NOT EXISTS idx_trades_error ON trades(error_tag);
        ",
    )
    .map_err(|e| format!("Failed to initialize DuckDB schema: {}", e))
}

fn query_summary(conn: &Connection, db_path: PathBuf) -> Result<AnalyticsSummary, String> {
    let (trade_count, trading_day_count, total_buy_amount, total_sell_amount, total_fee, total_error_cost, latest_trade_date) = conn
        .query_row(
            "
            SELECT
                COUNT(*)::BIGINT,
                COUNT(DISTINCT date)::BIGINT,
                COALESCE(SUM(CASE WHEN direction = 'buy' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN direction = 'sell' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(fee + stamp_tax + transfer_fee), 0),
                COALESCE(SUM(error_cost), 0),
                MAX(date)
            FROM trades
            ",
            params![],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, f64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to query analytics summary: {}", e))?;

    Ok(AnalyticsSummary {
        source: "duckdb".to_string(),
        database_path: db_path.to_string_lossy().to_string(),
        trade_count,
        trading_day_count,
        total_buy_amount,
        total_sell_amount,
        total_fee,
        total_error_cost,
        turnover_amount: total_buy_amount + total_sell_amount,
        latest_trade_date,
        mode_stats: query_tag_stats(conn, "mode_tag")?,
        certainty_stats: query_tag_stats(conn, "certainty_tag")?,
        planned_stats: query_planned_stats(conn)?,
        error_stats: query_tag_stats(conn, "error_tag")?,
        agent_stats: query_tag_stats(conn, "agent_source")?,
        average_health_score: query_average_health_score(conn)?,
    })
}

fn query_tag_stats(conn: &Connection, column: &str) -> Result<Vec<AnalyticsTagStat>, String> {
    let sql = format!(
        "
        SELECT
            {column} AS tag,
            COUNT(*)::BIGINT,
            COALESCE(SUM(CASE WHEN direction = 'buy' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'sell' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(fee + stamp_tax + transfer_fee), 0),
            COALESCE(SUM(error_cost), 0)
        FROM trades
        WHERE {column} IS NOT NULL AND length(trim({column})) > 0
        GROUP BY {column}
        ORDER BY COUNT(*) DESC, tag ASC
        "
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare tag stats query: {}", e))?;
    let rows = stmt
        .query_map(params![], |row| {
            Ok(AnalyticsTagStat {
                tag: row.get(0)?,
                trade_count: row.get(1)?,
                buy_amount: row.get(2)?,
                sell_amount: row.get(3)?,
                fee: row.get(4)?,
                error_cost: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query tag stats: {}", e))?;

    let mut stats = Vec::new();
    for row in rows {
        stats.push(row.map_err(|e| format!("Failed to read tag stats row: {}", e))?);
    }
    Ok(stats)
}

fn query_planned_stats(conn: &Connection) -> Result<Vec<AnalyticsTagStat>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
                CASE
                    WHEN planned_trade = true THEN '计划内'
                    WHEN planned_trade = false THEN '计划外'
                    ELSE '未标注'
                END AS tag,
                COUNT(*)::BIGINT,
                COALESCE(SUM(CASE WHEN direction = 'buy' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN direction = 'sell' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(fee + stamp_tax + transfer_fee), 0),
                COALESCE(SUM(error_cost), 0)
            FROM trades
            GROUP BY tag
            ORDER BY COUNT(*) DESC, tag ASC
            ",
        )
        .map_err(|e| format!("Failed to prepare planned stats query: {}", e))?;
    let rows = stmt
        .query_map(params![], |row| {
            Ok(AnalyticsTagStat {
                tag: row.get(0)?,
                trade_count: row.get(1)?,
                buy_amount: row.get(2)?,
                sell_amount: row.get(3)?,
                fee: row.get(4)?,
                error_cost: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query planned stats: {}", e))?;

    let mut stats = Vec::new();
    for row in rows {
        stats.push(row.map_err(|e| format!("Failed to read planned stats row: {}", e))?);
    }
    Ok(stats)
}

fn query_average_health_score(conn: &Connection) -> Result<Option<f64>, String> {
    conn.query_row(
        "
        SELECT AVG(health_score)
        FROM trades
        WHERE direction = 'buy' AND health_score IS NOT NULL
        ",
        params![],
        |row| row.get::<_, Option<f64>>(0),
    )
    .map_err(|e| format!("Failed to query average health score: {}", e))
}

fn clean_optional_tag(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}
