FROM node:16-alpine AS build

WORKDIR /app 

ADD . .

RUN \
  apk --no-cache --virtual build-dependencies add \
  g++ gcc libgcc libstdc++ linux-headers make python3

RUN \
  npm install

CMD npm start