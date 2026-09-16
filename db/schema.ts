import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const dubProjects = sqliteTable("dub_projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  archiveKey: text("archive_key").notNull().unique(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  youtubeUrl: text("youtube_url"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_dub_projects_created_at").on(table.createdAt),
]);
