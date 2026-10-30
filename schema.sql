-- Mỗi ghi chú, bộ đề, lượt làm bài, bộ từ là một dòng JSON trong bảng docs.
-- col: notes | quizzes | attempts | decks
CREATE TABLE IF NOT EXISTS docs (
  col        TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_col_updated ON docs (col, updated_at);
