// The 'test_test_pos' test program.
import test_pos.aleo;
program test_test_pos.aleo {
    @test
    script test_it() {
        let result: u32 = test_pos.aleo/main(1u32, 2u32);
        assert_eq(result, 3u32);
    }

    @test
    @should_fail
    transition do_nothing() {
        let result: u32 = test_pos.aleo/main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    async constructor() {}
}
