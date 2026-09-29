.PHONY: test dev
test:
	node --test 'collector/test/*.test.js' 'scene/test/*.test.js'
dev: vendor
	node collector/index.js --scene scene

THREE_VERSION := 0.186.1
.PHONY: vendor
vendor: scene/vendor/three/three.module.js
scene/vendor/three/three.module.js:
	rm -rf build/three && mkdir -p build/three scene/vendor/three/addons
	cd build/three && npm pack three@$(THREE_VERSION) --silent >/dev/null && tar xzf three-$(THREE_VERSION).tgz
	cp build/three/package/build/three.module.js build/three/package/build/three.core.js build/three/package/LICENSE scene/vendor/three/
	cp -R build/three/package/examples/jsm/postprocessing build/three/package/examples/jsm/shaders scene/vendor/three/addons/

APP := build/Atlas.app
.PHONY: app install run clean
app: vendor
	cd app && swift build -c release
	rm -rf $(APP) && mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp app/.build/release/Atlas $(APP)/Contents/MacOS/
	cp app/Info.plist $(APP)/Contents/
	cp -R scene collector $(APP)/Contents/Resources/
	rm -rf $(APP)/Contents/Resources/scene/test $(APP)/Contents/Resources/collector/test
	codesign --force --deep --sign - $(APP)
install: app
	-osascript -e 'quit app "Atlas"' 2>/dev/null
	mkdir -p ~/Applications && rm -rf ~/Applications/Atlas.app && cp -R $(APP) ~/Applications/
	open ~/Applications/Atlas.app
run: app
	open $(APP)
clean:
	rm -rf build app/.build
