FROM node:24-alpine AS guest
RUN apk add --no-cache linux-virt cpio \
    && mkdir -p /guest/dev /guest/proc /guest/sys /guest/tmp /guest/app \
    && cp -a /bin /sbin /lib /etc /guest/ \
    && mkdir -p /guest/usr/local/bin && cp /usr/local/bin/node /guest/usr/local/bin/ \
    && mkdir -p /guest/usr/lib && cp -a /usr/lib/*.so* /guest/usr/lib/ \
    && rm -f /guest/etc/resolv.conf
COPY guest-init /guest/init
RUN chmod 0755 /guest/init \
    && cd /guest && find . | cpio -o -H newc | gzip > /guest.cpio.gz

FROM alpine:3.24
RUN apk add --no-cache qemu-system-x86_64 cpio socat
COPY --from=guest /boot/vmlinuz-virt /opt/konoha/kernel
COPY --from=guest /guest.cpio.gz /opt/konoha/guest.cpio.gz
COPY start-vm /opt/konoha/start-vm
ENTRYPOINT ["/bin/sh", "/opt/konoha/start-vm"]
