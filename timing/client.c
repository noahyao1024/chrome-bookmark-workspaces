#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

uint64_t chrome_timing_now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static int ready_fd(int fd, short events, uint64_t deadline) {
    uint64_t now = chrome_timing_now_ns();
    if (now >= deadline) return 0;
    int ms = (int)((deadline - now + 999999) / 1000000);
    struct pollfd p = {.fd=fd,.events=events};
    return poll(&p, 1, ms) > 0 && (p.revents & events);
}

// A missing or busy collector never blocks the workflow beyond this deadline.
int chrome_timing_exchange_tracked(const char *path, const char *message, char *reply, int capacity, int timeout_ms, int *dispatched) {
    if (dispatched) *dispatched=0;
    if (!path || !message || capacity < 2 || strlen(message) > 60000) return 0;
    struct sockaddr_un addr = {.sun_family=AF_UNIX};
    if (strlen(path) >= sizeof(addr.sun_path)) return 0;
    strcpy(addr.sun_path, path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    int one=1;setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one));
    uint64_t deadline=chrome_timing_now_ns()+(uint64_t)timeout_ms*1000000;
    if (connect(fd,(struct sockaddr *)&addr,sizeof(addr)) < 0) {
        if (errno!=EINPROGRESS || !ready_fd(fd,POLLOUT,deadline)) { close(fd);return 0; }
        int error=0;socklen_t len=sizeof(error);getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&len);
        if(error) {close(fd);return 0;}
    }
    size_t length=strlen(message), sent=0;
    while(sent<length) {
        ssize_t n=write(fd,message+sent,length-sent);
        if(n>0){sent+=(size_t)n;if(dispatched)*dispatched=1;}
        else if((errno!=EAGAIN && errno!=EINTR) || !ready_fd(fd,POLLOUT,deadline)) {close(fd);return 0;}
    }
    shutdown(fd,SHUT_WR);
    int used=0;
    while(used<capacity-1) {
        ssize_t n=read(fd,reply+used,(size_t)(capacity-1-used));
        if(n>0) used+=(int)n;
        else if(n==0)break;
        else if((errno!=EAGAIN && errno!=EINTR) || !ready_fd(fd,POLLIN,deadline))break;
    }
    reply[used]=0;close(fd);return used;
}

int chrome_timing_exchange(const char *path, const char *message, char *reply, int capacity, int timeout_ms) {
    return chrome_timing_exchange_tracked(path,message,reply,capacity,timeout_ms,NULL);
}

#ifdef CHROME_TIMING_CLI
static char *quoted(const char *s) {
    size_t n=strlen(s);char *out=malloc(n*6+3),*p=out;*p++='"';
    for(size_t i=0;i<n;i++) {
        unsigned char c=(unsigned char)s[i];
        if(c=='"'||c=='\\'){*p++='\\';*p++=(char)c;}
        else if(c<32){sprintf(p,"\\u%04x",c);p+=6;}
        else *p++=(char)c;
    }
    *p++='"';*p=0;return out;
}
int main(int argc,char **argv) {
    if(argc<3)return 0;
    const char *home=getenv("HOME");if(!home)return 0;
    char path[1024];snprintf(path,sizeof(path),"%s/Library/Caches/BookmarkWorkspaces/timing.sock",home);
    if(access(path,F_OK)!=0){puts("{}");return 0;}
    char *type=quoted(argv[1]),*trace=quoted(argv[2]);
    const char *data=argc>3 && argv[3][0]?argv[3]:"null";
    const char *context=argc>4 && argv[4][0]?argv[4]:"null";
    const char *status=argc>5 && argv[5][0]?argv[5]:"null";
    char *copy=NULL;
    if(strcmp(argv[1],"copy_begin")==0) {
        char *url=quoted(data);asprintf(&copy,"{\"url\":%s}",url);free(url);data=copy;
    }
    char *message=NULL;asprintf(&message,"{\"type\":%s,\"trace\":%s,\"atNs\":\"%llu\",\"data\":%s,\"context\":%s,\"status\":%s}\n",type,trace,(unsigned long long)chrome_timing_now_ns(),data,context,status);
    char reply[4096];int n=chrome_timing_exchange(path,message,reply,sizeof(reply),12);
    if(n>0)fputs(reply,stdout);else puts("{}");
    free(type);free(trace);free(message);free(copy);return 0;
}
#endif
