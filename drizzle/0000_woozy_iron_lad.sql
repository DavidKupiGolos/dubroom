CREATE TABLE `dub_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`archive_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dub_projects_archive_key_unique` ON `dub_projects` (`archive_key`);