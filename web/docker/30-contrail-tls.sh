#!/bin/sh
# ══════════════════════════════════════════════════════════════════════
#  Provide the HTTPS server's certificate, before nginx starts.
#
#  Run by the nginx image's entrypoint (every executable *.sh in
#  /docker-entrypoint.d). nginx.conf reads /etc/nginx/tls-active/{cert,key}.pem;
#  this decides what those are:
#
#   1. A certificate mounted at /etc/nginx/tls/{cert,key}.pem — e.g. one made
#      with mkcert, which the browser then trusts. Used as-is.
#   2. Otherwise a self-signed one is generated, valid for localhost, 127.0.0.1
#      and ::1 plus TLS_SERVER_NAMES / TLS_SERVER_IPS, and written to the same
#      mounted directory when it is writable (so it survives the container being
#      recreated and can be trusted once), else inside the container.
#
#  It never overwrites a certificate it did not generate, and it fails nginx's
#  start rather than serve with a broken key: a web tier that starts without
#  TLS when TLS was asked for is worse than one that says why it did not start.
# ══════════════════════════════════════════════════════════════════════
set -eu

MOUNT=/etc/nginx/tls
FALLBACK=/var/cache/contrail-tls
ACTIVE=/etc/nginx/tls-active
DAYS="${TLS_SELF_SIGNED_DAYS:-397}"   # the most any browser accepts for a leaf

say() { echo "contrail-tls: $*"; }

if [ -s "$MOUNT/cert.pem" ] && [ -s "$MOUNT/key.pem" ]; then
    source_dir="$MOUNT"
    if [ -f "$MOUNT/.contrail-self-signed" ]; then
        say "using the self-signed certificate generated earlier in $MOUNT"
    else
        say "using the certificate mounted at $MOUNT"
    fi
else
    source_dir="$MOUNT"
    if ! { mkdir -p "$MOUNT" && touch "$MOUNT/.write-test" && rm -f "$MOUNT/.write-test"; } 2>/dev/null; then
        source_dir="$FALLBACK"
        mkdir -p "$FALLBACK"
    fi
    if [ ! -s "$source_dir/cert.pem" ] || [ ! -s "$source_dir/key.pem" ]; then
        san="DNS:localhost,IP:127.0.0.1,IP:::1"
        old_ifs="$IFS"; IFS=','
        for name in ${TLS_SERVER_NAMES:-}; do [ -n "$name" ] && san="$san,DNS:$name"; done
        for ip in ${TLS_SERVER_IPS:-}; do [ -n "$ip" ] && san="$san,IP:$ip"; done
        IFS="$old_ifs"
        say "no certificate mounted; generating a self-signed one ($san), $DAYS days"
        umask 077
        openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$DAYS" \
            -keyout "$source_dir/key.pem" -out "$source_dir/cert.pem" \
            -subj "/O=Contrail (self-signed, development)/CN=localhost" \
            -addext "subjectAltName=$san" \
            -addext "basicConstraints=critical,CA:FALSE" \
            -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" 2>/dev/null
        chmod 644 "$source_dir/cert.pem"
        : > "$source_dir/.contrail-self-signed"
    fi
fi

# The key must match the certificate, or nginx starts and every handshake fails.
cert_key=$(openssl x509 -noout -pubkey -in "$source_dir/cert.pem" | openssl sha256)
key_key=$(openssl pkey -pubout -in "$source_dir/key.pem" | openssl sha256)
if [ "$cert_key" != "$key_key" ]; then
    say "ERROR: $source_dir/key.pem does not match $source_dir/cert.pem" >&2
    exit 1
fi

mkdir -p "$ACTIVE"
ln -sf "$source_dir/cert.pem" "$ACTIVE/cert.pem"
ln -sf "$source_dir/key.pem" "$ACTIVE/key.pem"
say "HTTPS on :8443 with $(openssl x509 -noout -subject -enddate -in "$source_dir/cert.pem" | tr '\n' ' ')"
