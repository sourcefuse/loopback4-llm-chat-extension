
CREATE SCHEMA IF NOT EXISTS chatbot;

CREATE EXTENSION vector WITH SCHEMA chatbot;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA chatbot;

CREATE TABLE chatbot.chats (
	id uuid DEFAULT chatbot.uuid_generate_v4() NOT NULL,
	tenant_id uuid NOT NULL,
	user_id uuid NOT NULL,
	title varchar(200) NOT NULL,
	input_tokens int4 DEFAULT 0 NOT NULL,
	output_tokens int4 DEFAULT 0 NOT NULL,
    metadata jsonb NOT NULL,
	created_by uuid NULL,
	created_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	deleted bool DEFAULT false NOT NULL,
	deleted_by uuid NULL,
	deleted_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	modified_by uuid NULL,
	modified_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	metadata jsonb NOT NULL,
	CONSTRAINT pk_chats_id PRIMARY KEY (id)
);

CREATE TABLE chatbot.messages (
	id uuid DEFAULT chatbot.uuid_generate_v4() NOT NULL,
	body text NOT NULL,
	channel_id uuid NOT NULL,
	channel_type varchar(200) NOT NULL,
	created_by uuid NULL,
	created_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	deleted bool DEFAULT false NOT NULL,
	deleted_by uuid NULL,
	deleted_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	modified_by uuid NULL,
	modified_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	status int4 DEFAULT 0 NOT NULL,
	subject varchar(200) NULL,
	to_user_id uuid NULL,
	parent_message_id uuid NULL,
	metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT pk_messages_id PRIMARY KEY (id)
);

CREATE TABLE chatbot.datasets (
	id uuid DEFAULT chatbot.uuid_generate_v4() NOT NULL,
	tenant_id uuid NOT NULL,
	votes integer DEFAULT 0 NOT NULL,
	modified_on timestamptz NULL,
	created_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	deleted_on timestamptz NULL,
	deleted_by uuid NULL,
	created_by uuid NOT NULL,
	modified_by uuid NULL,
	deleted bool NULL,
	description varchar NOT NULL,
	query varchar NOT NULL,
	prompt varchar NOT NULL,
	"tables" _varchar NOT NULL,
	schema_hash varchar NOT NULL,
	CONSTRAINT pk_dataset PRIMARY KEY (id)
);

create table chatbot.dataset_actions (
    id uuid DEFAULT chatbot.uuid_generate_v4() NOT NULL,
    dataset_id uuid NOT NULL,
    action smallint NOT NULL,
    comment varchar(500) NULL,
    user_id uuid NOT NULL,
    acted_on timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_dataset_actions PRIMARY KEY (id),
    CONSTRAINT fk_dataset_actions_dataset FOREIGN KEY (dataset_id) REFERENCES chatbot.datasets(id) ON DELETE CASCADE
);


CREATE OR REPLACE FUNCTION chatbot.moddatetime()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
BEGIN
    NEW.modified_on = now();
    RETURN NEW;
END;
$function$;

create trigger mdt_datasets before
update
    on
    chatbot.datasets for each row execute function chatbot.moddatetime('modified_on');

create trigger mdt_messages before
update
    on
    chatbot.messages for each row execute function chatbot.moddatetime('modified_on');

create trigger mdt_chats before
update
    on
    chatbot.chats for each row execute function chatbot.moddatetime('modified_on');