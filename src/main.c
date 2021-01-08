/*
 * SPDX-License-Identifier: MIT AND GPL-2.0-or-later
 *
 * cgi-swupdate - CGI swupdate helper
 *
 * Copyright (C) 2021 Tano Systems LLC. All Rights Reserved.
 * Anton Kikin <a.kikin@tano-systems.com>
 *
 * Used some parts of code from cgi-io project (GPL-2.0-or-later)
 * (https://git.openwrt.org/project/cgi-io.git)
 *
 * Using Multipart form data parser (MIT)
 * (https://github.com/iafonov/multipart-parser-c)
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#ifndef SYSLOG_DEBUG
#define SYSLOG_DEBUG 0
#endif

#if SYSLOG_DEBUG
#include <syslog.h>
#endif

#include <libubus.h>
#include <libubox/blobmsg.h>

#include "multipart_parser.h"

#include "network_ipc.h" /* swupdate IPC header */

/* ------------------------------------------------------------------------------------- */

#define SWU_BUFFER_FLUSH_RELAX 1

#define STDIN_BUFFER_SIZE_INITIAL  (4 * 1024)
#define STDIN_BUFFER_SIZE_MAX      (256 * 1024)
#define SWU_BUFFER_SIZE            (STDIN_BUFFER_SIZE_MAX)

static size_t stdin_buffer_size = STDIN_BUFFER_SIZE_INITIAL;

enum part
{
	PART_UNKNOWN,
	PART_SESSIONID,
	PART_FILENAME,
	PART_POSTUPDATE,
	PART_CLEARDATA,
	PART_DRYRUN,
	PART_SWU_SOFTWARE_SET,
	PART_SWU_RUNNING_MODE,
//	PART_CHUNK,
//	PART_NCHUNKS,
	PART_SWUPDATEDATA,
};

const char *parts[] =
{
	"(bug)",
	"sessionid",
	"filename",
	"postupdate",
	"cleardata",
	"dryrun",
	"swu_software_set",
	"swu_running_mode",
//	"chunk",
//	"nchunks",
	"swupdatedata",
};

struct state
{
	bool is_content_disposition;
	enum part parttype;

	char *sessionid;
	char *filename;
	bool postupdate;
	bool cleardata;
	bool dryrun;
	char *swu_software_set;
	char *swu_running_mode;
//	unsigned int chunk;
//	unsigned int nchunks;
	int swupdatefd;
};

static struct state st;

/* ------------------------------------------------------------------------------------- */

static char *datadup(const void *in, size_t len)
{
	char *out = malloc(len + 1);

	if (!out)
		return NULL;

	memcpy(out, in, len);

	*(out + len) = 0;

	return out;
}

/* ------------------------------------------------------------------------------------- */

enum {
	SES_ACCESS,
	__SES_MAX,
};

static const struct blobmsg_policy ses_policy[__SES_MAX] = {
	[SES_ACCESS] = { .name = "access", .type = BLOBMSG_TYPE_BOOL },
};

static void ubus_session_access_cb(
	struct ubus_request *req,
	int type,
	struct blob_attr *msg)
{
	struct blob_attr *tb[__SES_MAX];
	bool *allow = (bool *)req->priv;

	if (!msg)
		return;

	blobmsg_parse(ses_policy, __SES_MAX, tb, blob_data(msg), blob_len(msg));

	if (tb[SES_ACCESS])
		*allow = blobmsg_get_bool(tb[SES_ACCESS]);
}

static bool ubus_session_access(
	const char *sid,
	const char *scope,
	const char *obj,
	const char *func,
	bool *expired
)
{
	uint32_t id;
	bool allow = false;
	int res;
	struct ubus_context *ctx;
	static struct blob_buf req;

	ctx = ubus_connect(NULL);

	if (!ctx || !obj || ubus_lookup_id(ctx, "session", &id))
		goto out;

	blob_buf_init(&req, 0);
	blobmsg_add_string(&req, "ubus_rpc_session", sid);
	blobmsg_add_string(&req, "scope", scope);
	blobmsg_add_string(&req, "object", obj);
	blobmsg_add_string(&req, "function", func);

	res = ubus_invoke(ctx, id, "access", req.head, ubus_session_access_cb, &allow, 500);
	if (expired) {
		if (res == UBUS_STATUS_NOT_FOUND)
			*expired = true;
		else
			*expired = false;
	}

out:
	if (ctx)
		ubus_free(ctx);

	return allow;
}

/* ------------------------------------------------------------------------------------- */

static int response(bool success, const char *message)
{
	#if SYSLOG_DEBUG
		syslog(LOG_INFO, "%s: success = %d, message = %s\n",
			__FUNCTION__, success, message);
	#endif

	printf("Status: 200 OK\r\n");
	printf("Content-Type: text/plain\r\n\r\n{\n");

	if (!success) {
		if (message)
			printf("\t\"message\": \"%s\",\n", message);

		printf("\t\"failure\": [ %u, \"%s\" ]\n", errno, strerror(errno));
	}

	printf("}\n");
	fflush(stdout);

	// TODO: Do not exit
	if (!success)
		exit(0);

	return -1;
}

static int failure(int code, int e, const char *message)
{
	#if SYSLOG_DEBUG
		syslog(LOG_INFO, "%s: code = %d, e = %d, message = %s\n",
			__FUNCTION__, code, e, message);
	#endif

	printf("Status: %d %s\r\n", code, message);
	printf("Content-Type: text/plain\r\n\r\n");
	printf("%s", message);

	if (e)
		printf(": %s", strerror(e));

	printf("\n");
	fflush(stdout);

	// TODO: Do not exit
	exit(0);
//	return -1;
}

static int response_session_expired(void)
{
	#if SYSLOG_DEBUG
		syslog(LOG_INFO, "%s: Session expired\n", __FUNCTION__);
	#endif

	return response(false, "Session expired");
}

/* ------------------------------------------------------------------------------------- */

static char *swu_buffer;
static int swu_buffer_len = 0;

static void swu_buffer_init(void)
{
	swu_buffer = malloc(SWU_BUFFER_SIZE);
	swu_buffer_len = 0;
}

static void swu_buffer_free(void)
{
	free(swu_buffer);
	swu_buffer_len = 0;
}

static int swu_write(const char *buf, size_t len)
{
	ssize_t total_written = 0;
	ssize_t total_len = len;

	ssize_t written = 0;
	ssize_t wlen = len;

	if (!len)
		return 0;

	do {
		written = write(st.swupdatefd, buf + total_written, wlen);

		/* IPC seems to block, wait for a while */
		if (written != wlen) {
			if ((errno != 0) &&
			    (errno != EAGAIN) &&
			    (errno != EWOULDBLOCK))
				return -1;

			usleep(100);

			if (written < 0)
				written = 0;
		}

		total_written += written;
		wlen -= written;
	} while(total_written != total_len);

	return 0;
}

static int swu_buffer_flush(void)
{
	int ret;

#if SWU_BUFFER_FLUSH_RELAX
	usleep(1000);
#endif

	ret = swu_write(swu_buffer, swu_buffer_len);

	if (ret)
		return ret;

	swu_buffer_len = 0;
	return 0;
}

static int swu_buffer_append(const char *data, size_t len)
{
	size_t remaining = len;
	size_t written = 0;

	while (remaining) {
		size_t available = SWU_BUFFER_SIZE - swu_buffer_len;
		size_t size = remaining;

		if (size > available)
			size = available;

		memcpy(swu_buffer + swu_buffer_len, data + written, size);
		swu_buffer_len += size;
		written += size;
		remaining -= size;

		if (swu_buffer_len == SWU_BUFFER_SIZE) {
			if (swu_buffer_flush())
				return -1;
		}
	}

	return 0;
}

/* ------------------------------------------------------------------------------------- */

static int parse_on_header_field(multipart_parser *p, const char *data, size_t len)
{
	st.is_content_disposition = !strncasecmp(data, "Content-Disposition", len);
	return 0;
}

static int parse_on_header_value(multipart_parser *p, const char *data, size_t len)
{
	size_t i, j;

	if (!st.is_content_disposition)
		return 0;

	if (len < 10 || strncasecmp(data, "form-data", 9))
		return 0;

	for (data += 9, len -= 9; *data == ' ' || *data == ';'; data++, len--)
		continue;

	if (len < 8 || strncasecmp(data, "name=\"", 6))
		return 0;

	for (data += 6, len -= 6, i = 0; i <= len; i++) {
		if (*(data + i) != '"')
			continue;

		for (j = 1; j < sizeof(parts) / sizeof(parts[0]); j++)
			if (!strncmp(data, parts[j], i))
				st.parttype = j;

		break;
	}

	return 0;
}

static int parse_on_headers_complete(multipart_parser *p)
{
	#if SYSLOG_DEBUG
		syslog(LOG_INFO, "%s: Part type %d\n", __FUNCTION__, st.parttype);
	#endif

	if (st.parttype == PART_SWUPDATEDATA)
	{
		struct swupdate_request req;
		bool session_expired = false;

		if (!st.sessionid)
			return response(false, "No sessionid specified");

		if (!st.filename)
			return response(false, "No filename specified");

//		if (!st.chunk || !st.nchunkcs)
//			return response(false, "No chunk and/or nchunks specified");

//		if (st.chunk > st.nchunks)
//			return response(false, "Invalid chunk and/or nchunks specified");

		if (!ubus_session_access(st.sessionid, "cgi-swupdate", "update", "write", &session_expired)) {
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: Session access check failed (expired = %d)\n",
					__FUNCTION__, session_expired);
			#endif

			return session_expired
				? response_session_expired()
				: response(false, "Access to update denied by ACL");
		}

		swupdate_prepare_req(&req);
		req.len = strlen(st.filename);
		req.dry_run = st.dryrun ? RUN_DRYRUN : RUN_INSTALL;
		strncpy(req.info, st.filename, sizeof(req.info) - 1);

		if (st.swu_software_set && st.swu_software_set[0])
			strncpy(req.software_set, st.swu_software_set, sizeof(req.software_set) - 1);

		if (st.swu_running_mode && st.swu_running_mode[0])
			strncpy(req.running_mode, st.swu_running_mode, sizeof(req.running_mode) - 1);

		req.source = SOURCE_WEBSERVER;

		st.swupdatefd = ipc_inst_start_ext(&req, sizeof(req));
		if (st.swupdatefd < 0) {
			return failure(500, 0, "Failed to queue command to swupdate");
		}

		swu_buffer_init();

		/* Increase STDIN read buffer size to max */
		stdin_buffer_size = STDIN_BUFFER_SIZE_MAX;
	}

	return 0;
}

static int parse_on_part_data(multipart_parser *p, const char *data, size_t len)
{
	switch (st.parttype)
	{
		case PART_SESSIONID:
			st.sessionid = datadup(data, len);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: sessionid = %s\n", __FUNCTION__, st.sessionid);
			#endif
			break;

		case PART_FILENAME:
			st.filename = datadup(data, len);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: filename = %s\n", __FUNCTION__, st.filename);
			#endif
			break;

		case PART_POSTUPDATE:
			st.postupdate = !!strtoul(data, NULL, 10);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: postupdate = %d\n", __FUNCTION__, st.postupdate);
			#endif
			break;

		case PART_CLEARDATA:
			st.cleardata = !!strtoul(data, NULL, 10);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: cleardata = %d\n", __FUNCTION__, st.cleardata);
			#endif
			break;

		case PART_DRYRUN:
			st.dryrun = !!strtoul(data, NULL, 10);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: dryrun = %d\n", __FUNCTION__, st.dryrun);
			#endif
			break;

		case PART_SWU_SOFTWARE_SET:
			st.swu_software_set = datadup(data, len);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: swu_software_set = %s\n", __FUNCTION__, st.swu_software_set);
			#endif
			break;

		case PART_SWU_RUNNING_MODE:
			st.swu_running_mode = datadup(data, len);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: swu_running_mode = %s\n", __FUNCTION__, st.swu_running_mode);
			#endif
			break;

/*		case PART_CHUNK:
			st.chunk = strtoul(data, NULL, 10);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: chunk = %u\n", __FUNCTION__, st.chunk);
			#endif
			break;

		case PART_NCHUNKS:
			st.nchunks = strtoul(data, NULL, 10);
			#if SYSLOG_DEBUG
				syslog(LOG_INFO, "%s: nchunks = %d\n", __FUNCTION__, st.nchunks);
			#endif
			break;
*/
		case PART_SWUPDATEDATA: {
			if (swu_buffer_append(data, len)) {
				return failure(500, 0, "Failed to queue command to swupdate");
			}
			break;
		}

		default:
			break;
	}

	return 0;
}

static int parse_on_part_data_end(multipart_parser *p)
{
	if (st.parttype == PART_SESSIONID)
	{
		bool session_expired = false;
		if (!ubus_session_access(st.sessionid, "cgi-swupdate", "update", "write", &session_expired)) {
			if (session_expired) {
				errno = EACCES;
				return response_session_expired();
			}
			else {
				errno = EPERM;
				return response(false, "Update permission denied");
			}
		}
	}
	else if (st.parttype == PART_SWUPDATEDATA)
	{
		ipc_message msg = {};

		swu_buffer_flush();
		swu_buffer_free();

		if (st.swupdatefd < 0)
			return response(false, "Internal program failure");

		/* Write clearoverlay flag to environment */
		/* Using swupdate shell scripts for doing this */
		char *tmpname = tmpnam(NULL);
		if (tmpname) {
			FILE *fpscript = fopen(tmpname, "w");
			if (fpscript) {
				/* Write script contents */
				fprintf(fpscript, "#!/bin/sh\n");
				fprintf(fpscript, ". /usr/lib/swupdate/swupdate.sh\n");
				fprintf(fpscript, "swupdate_set_clear_overlay \"%d\"\n", st.cleardata ? 1 : 0);
				fclose(fpscript);

				/* Execute temporary script */
				char command[128];
				snprintf(command, sizeof(command), "/bin/sh %s", tmpname);
				system(command);

				/* Remove temporary file */
				unlink(tmpname);
			}
		}

		if (st.postupdate) {
			int ret = ipc_postupdate(&msg);
			if (ret)
				return failure(500, 0, "Failed to queue command to swupdate");
		}

		ipc_end(st.swupdatefd);

		return response(true, NULL);
	}

	st.parttype = PART_UNKNOWN;
	return 0;
}

/* ------------------------------------------------------------------------------------- */

static multipart_parser_settings callbacks = {
	.on_part_data        = parse_on_part_data,
	.on_headers_complete = parse_on_headers_complete,
	.on_part_data_end    = parse_on_part_data_end,
	.on_header_field     = parse_on_header_field,
	.on_header_value     = parse_on_header_value
};

int main(int argc, char **argv)
{
	char *boundary;
	const char *var;

	int rem;
	int len;
	bool done = false;
	multipart_parser *p;
	char *buf;

	#if SYSLOG_DEBUG
		openlog("cgi-swupdate", 0, LOG_DAEMON);
	#endif

	var = getenv("CONTENT_TYPE");

	if (!var || strncmp(var, "multipart/form-data;", 20))
		return -1;

	for (var += 20; *var && *var != '='; var++)
		continue;

	if (*var++ != '=')
		return -1;

	buf = malloc(STDIN_BUFFER_SIZE_MAX);
	if (!buf) {
		errno = EINVAL;
		return response(false, "No memory");
	}

	boundary = malloc(strlen(var) + 3);

	if (!boundary)
		return -1;

	strcpy(boundary, "--");
	strcpy(boundary + 2, var);

	p = multipart_parser_init(boundary, &callbacks);

	free(boundary);

	if (!p) {
		errno = EINVAL;
		return response(false, "Invalid request");
	}

	st.filename = NULL;
	st.swupdatefd = -1;
	st.dryrun = 1; /* dry run by default */

	#if SYSLOG_DEBUG
		syslog(LOG_INFO, "%s: Start stdin reading loop\n", __FUNCTION__);
	#endif

	while ((len = fread(buf, 1, stdin_buffer_size, stdin)) > 0) {
		if (!done) {
			rem = multipart_parser_execute(p, buf, len);
			done = (rem < len);
		}
		if (feof(stdin) || ferror(stdin))
			break;
	}

	multipart_parser_free(p);
	free(buf);

	#if SYSLOG_DEBUG
		closelog();
	#endif

	return 0;
}

/* ------------------------------------------------------------------------------------- */
